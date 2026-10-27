'use strict';
const { Plugin, Modal, Notice, TFile, TFolder, parseYaml, stringifyYaml, normalizePath } = require('obsidian');

const MARKER = '_Inbox Settings.md';
const ACTIONS_MARKER = '<!-- papertrail-actions -->';
const ACTIONS_BLOCK = '```papertrail-actions\n```';
const TYPES = { text:'Short text', email:'Email', textarea:'Long text', select:'Dropdown', checkboxes:'Checkbox group', checkbox:'Single checkbox', number:'Number', date:'Date' };
const ROLE_LABELS = { none:'Regular field', sender:'Sender', subject:'Subject' };
const uuid = () => crypto.randomUUID();
const copy = x => JSON.parse(JSON.stringify(x));
const unique = xs => [...new Set(xs.filter(Boolean))];
const line = x => String(x ?? '').replace(/[\r\n]+/g,' ').trim();
const safeName = x => line(x).replace(/[\\/:*?"<>|#\[\]^\u0000-\u001f]/g,' ').replace(/\s+/g,' ').slice(0,100).replace(/[. ]+$/g,'') || 'Submission';
const splitNote = text => {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return { fm: match ? (parseYaml(match[1]) || {}) : {}, body: match ? text.slice(match[0].length) : text };
};
const pack = (fm, body) => `---\n${stringifyYaml(fm).trimEnd()}\n---\n\n${body.trimStart()}`;
function errorText(error) { return error && error.message ? error.message : String(error); }
function button(parent, text, fn, cls) {
  const el=parent.createEl('button',{text,cls});el.type='button';el.addEventListener('click',fn);return el;
}
function labelInput(parent, label, tag='input', type='text') {
  const wrap=parent.createEl('label',{cls:'pt-label'});wrap.createEl('span',{text:label});
  const input=wrap.createEl(tag);if(tag==='input')input.type=type;return input;
}
function selectInput(parent,label,options,selected) {
  const select=labelInput(parent,label,'select');
  for(const [value,text] of options) select.createEl('option',{text,value});
  select.value=selected||'';return select;
}
function showError(el, error) { el.textContent=errorText(error); }
function newField(overrides={}) { return {id:uuid(),label:'New field',type:'text',placeholder:'',required:false,storage:'body',role:'none',options:[],...overrides}; }
function newForm(name='Contact form') {
  return {id:uuid(),name,folderId:'',fields:[
    newField({label:'Email',type:'email',role:'sender',required:true,storage:'frontmatter',placeholder:'you@example.com'}),
    newField({label:'Subject',role:'subject',required:true,storage:'frontmatter',placeholder:'What is this about?'}),
    newField({label:'Message',type:'textarea',required:true,storage:'body',placeholder:'Write your message…'})
  ]};
}
function validateForm(form) {
  form.name=line(form.name);if(!form.name) throw Error('Give this form a name.');
  if(!Array.isArray(form.fields) || !form.fields.length) throw Error('Add fields to your form.');
  const ids=new Set();
  for(const field of form.fields) {
    field.label=line(field.label);if(!field.label)throw Error('Every field needs a label.');
    if(!field.id || ids.has(field.id))throw Error('Each field needs a unique ID.');ids.add(field.id);
    if(!TYPES[field.type])throw Error('Choose a supported input type.');
    if(!['none','sender','subject'].includes(field.role))throw Error('Choose a valid field role.');
    if(!['body','frontmatter'].includes(field.storage))throw Error('Choose where to store each answer.');
    field.options=unique((field.options||[]).map(v=>line(v)));
    if(['select','checkboxes'].includes(field.type) && !field.options.length)throw Error(`Add at least one choice for “${field.label}”.`);
    if(field.role!=='none' && !['text','email','select'].includes(field.type))throw Error(`“${field.label}” must be short text, email, or a dropdown to identify the sender or subject.`);
  }
  for(const role of ['sender','subject']) {
    const matches=form.fields.filter(f=>f.role===role);
    if(matches.length!==1)throw Error(`Choose exactly one ${role} field.`);
    matches[0].required=true;
  }
  const used=new Set(['email','subject','date_submitted','submitted_at','papertrail_kind','papertrail_id','current_inbox_id','visited_inboxes','completed_actions','thread_home_set','last_updated']);
  for(const f of form.fields) {
    if(f.role==='sender'){f.key='email';continue;}if(f.role==='subject'){f.key='subject';continue;}
    const base=f.label.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'')||'answer';
    let key=base;for(let n=2;used.has(key);n++)key=`${base}_${n}`;f.key=key;used.add(key);
  }
  return form;
}

module.exports = class PapertrailForms extends Plugin {
  async onload() {
    const saved=await this.loadData();
    this.data=Object.assign({forms:[],activeFormId:''},saved||{});
    if(!Array.isArray(this.data.forms)) this.data.forms=[];
    this.locks=new Set();
    this.addRibbonIcon('mail-plus','Open Papertrail Forms',()=>this.openForms());
    this.addCommand({id:'open-forms',name:'Open forms',callback:()=>this.openForms()});
    this.addCommand({id:'open-active-form',name:'Fill out active form',callback:()=>this.openActive()});
    this.addCommand({id:'reply-active-note',name:'Reply to current submission or thread',callback:()=>this.actionForActive('reply')});
    this.addCommand({id:'forward-active-note',name:'Forward current submission or thread',callback:()=>this.actionForActive('forward')});
    this.addCommand({id:'insert-active-form',name:'Insert active form into current note',callback:()=>this.insertActiveForm()});
    this.addCommand({id:'convert-legacy-form',name:'Convert current JS Engine form to a new note',callback:()=>this.convertLegacyForm()});
    this.registerMarkdownCodeBlockProcessor('papertrail-form',(source,el)=>this.renderEmbeddedForm(source,el));
    this.registerMarkdownCodeBlockProcessor('papertrail-actions',(source,el,ctx)=>this.renderActions(el,ctx.sourcePath));
  }
  async persist(){await this.saveData(this.data);}
  openForms(){new FormsModal(this).open();}
  openActive(){const form=this.data.forms.find(f=>f.id===this.data.activeFormId)||this.data.forms[0];if(form)new FillModal(this,form).open();else this.openForms();}
  async renderEmbeddedForm(source,el){
    const id=source.trim();
    const form=this.data.forms.find(f=>f.id===id);
    if(!form){el.createEl('p',{text:'Form not found. Open Papertrail Forms to create or restore it.',cls:'pt-error'});return;}
    try{await new FillModal(this,form,el).render();}catch(e){el.createEl('p',{text:errorText(e),cls:'pt-error'});}
  }
  async insertActiveForm(){
    const form=this.data.forms.find(f=>f.id===this.data.activeFormId)||this.data.forms[0];
    if(!form){new Notice('Create a form first.');this.openForms();return;}
    await this.insertForm(form);
  }
  async insertForm(form){
    try{
      const file=this.app.workspace.getActiveFile();
      if(!(file instanceof TFile)||file.extension!=='md')throw Error('Open the Markdown note where you want the form first.');
      const block='```papertrail-form\n'+form.id+'\n```';
      await this.app.vault.process(file,content=>{
        if(content.includes(block))throw Error('That form is already embedded in this note.');
        return content.trimEnd()+'\n\n'+block+'\n';
      });
      new Notice('Form added. Open Reading view to fill it out.');
    }catch(e){new Notice(errorText(e));}
  }
  async convertLegacyForm(){
    try{
      const file=this.app.workspace.getActiveFile();
      if(!(file instanceof TFile)||file.extension!=='md')throw Error('Open the original JS Engine form note first.');
      const text=await this.app.vault.read(file),doc=splitNote(text);
      // Match only our known earlier builders. Never replace unrelated JS Engine blocks.
      const pattern=/^```js-engine[ \t]*\r?\n([\s\S]*?)^```[ \t]*(?:\r?\n|$)/gm;
      let selected=null,match;
      while((match=pattern.exec(text))){
        const code=match[1];
        if(code.includes('const email = field(')&&code.includes('const subject = field(')&&code.includes('const message = field(')||
           code.includes('const defaultFields =')&&code.includes('papertrail_form')&&code.includes('inbox_folder_id')){
          if(selected)throw Error('More than one Papertrail form was found. Convert one form per note.');selected=match;
        }
      }
      if(!selected)throw Error('This note does not contain a recognized Papertrail JS Engine form. Open the form note itself and try again.');
      const form=newForm(`${file.basename||file.name.replace(/\.md$/i,'')} (converted)`);
      const legacy=doc.fm.papertrail_form;
      if(legacy && Array.isArray(legacy.fields))form.fields=copy(legacy.fields);
      form.folderId=typeof doc.fm.inbox_folder_id==='string'?doc.fm.inbox_folder_id:'';
      // The first, simple version used a literal Inbox folder instead of an ID.
      if(!form.folderId){
        const literal=selected[1].match(/const\s+folder\s*=\s*['"]([^'"\r\n]+)['"]/);
        if(literal){const folder=this.app.vault.getAbstractFileByPath(normalizePath(literal[1]));if(folder instanceof TFolder)form.folderId=await this.inboxId(folder);}
      }
      validateForm(form);
      const block='```papertrail-form\n'+form.id+'\n```\n';
      const converted=text.slice(0,selected.index)+block+text.slice(selected.index+selected[0].length);
      const folder=file.parent?.isRoot()?'':file.parent?.path||'';
      const parent=folder;
      const path=await this.freePath(parent,(file.basename||file.name.replace(/\.md$/i,''))+' - Papertrail Forms.md');
      this.data.forms.push(form);const previous=this.data.activeFormId;this.data.activeFormId=form.id;
      try{await this.persist();await this.app.vault.create(path,converted);}
      catch(e){this.data.forms=this.data.forms.filter(f=>f.id!==form.id);this.data.activeFormId=previous;try{await this.persist();}catch(_e){}throw e;}
      const created=this.app.vault.getAbstractFileByPath(path);
      if(created instanceof TFile)await this.app.workspace.getLeaf(false).openFile(created);
      new Notice(form.folderId?'Converted copy created. Open Reading view.':'Converted copy created. Open Forms → Edit to choose an inbox.');
    }catch(e){new Notice(errorText(e));}
  }
  async actionForActive(mode){
    try{const file=this.app.workspace.getActiveFile();if(!(file instanceof TFile))throw Error('Open a submission or thread first.');const doc=await this.read(file);if(!doc.fm.papertrail_id)throw Error('This is not a Papertrail submission.');new ActionModal(this,doc.fm.papertrail_id,doc.fm.inbox_folder_id,mode).open();}catch(e){new Notice(errorText(e));}
  }
  async read(file){return splitNote(await this.app.vault.read(file));}
  folders(){return this.app.vault.getAllLoadedFiles().filter(f=>f instanceof TFolder&&!f.isRoot()&&f.path!=='Threads'&&!f.path.startsWith('Threads/')&&f.path!=='_Papertrail'&&!f.path.startsWith('_Papertrail/')).sort((a,b)=>a.path.localeCompare(b.path));}
  async ensureFolder(path){
    let folder=this.app.vault.getAbstractFileByPath(path);
    if(!folder){try{folder=await this.app.vault.createFolder(path);}catch(e){folder=this.app.vault.getAbstractFileByPath(path);if(!folder)throw e;}}
    if(!(folder instanceof TFolder))throw Error(`A file blocks the folder “${path}”.`);return folder;
  }
  async inboxId(folder){
    if(!(folder instanceof TFolder)||folder.isRoot())throw Error('Choose a folder for the inbox.');
    const path=normalizePath(`${folder.path}/${MARKER}`);let marker=this.app.vault.getAbstractFileByPath(path);
    if(!marker){
      const id=uuid();try{await this.app.vault.create(path,pack({inbox_folder_id:id},'# Inbox Settings\n\nKeep this note in the inbox. It lets Papertrail Forms follow the folder when it is moved or renamed.\n'));return id;}
      catch(e){marker=this.app.vault.getAbstractFileByPath(path);if(!marker)throw e;}
    }
    if(!(marker instanceof TFile))throw Error(`The ${MARKER} item must be a note.`);
    const id=(await this.read(marker)).fm.inbox_folder_id;if(typeof id!=='string'||!id)throw Error(`An unrelated ${MARKER} already exists in ${folder.path}.`);return id;
  }
  async inboxes(){
    const map=new Map();for(const file of this.app.vault.getMarkdownFiles().filter(f=>f.name===MARKER)){
      const id=(await this.read(file)).fm.inbox_folder_id;if(!id)continue;
      if(map.has(id))throw Error('Two inbox folders share the same settings ID. Remove the copied _Inbox Settings note from one folder and select it again.');map.set(id,file.parent);
    }return map;
  }
  async canonical(id){
    const hits=[];
    for(const f of this.app.vault.getMarkdownFiles()){
      // Only parse frontmatter of notes that could belong to this conversation.
      const text=await this.app.vault.cachedRead(f);if(!text.includes(id))continue;
      try{const fm=splitNote(text).fm;if(fm.papertrail_id===id&&['submission','thread'].includes(fm.papertrail_kind))hits.push(f);}catch(_e){/* unrelated malformed notes do not block correspondence */}
    }
    if(hits.length!==1)throw Error(hits.length?'Duplicate conversation notes share an ID.':'The submission or thread could not be found.');return hits[0];
  }
  async freePath(folder,filename,self){const stem=filename.replace(/\.md$/i,'');for(let n=0;;n++){const path=normalizePath(`${folder ? folder+'/' : ''}${stem}${n?` (${n})`:''}.md`);const found=this.app.vault.getAbstractFileByPath(path);if(!found||found===self)return path;}}
  async createUnique(folder,filename,content){for(let n=0;;n++){const stem=filename.replace(/\.md$/i,'');const path=normalizePath(`${folder}/${stem}${n?` (${n})`:''}.md`);if(this.app.vault.getAbstractFileByPath(path))continue;try{return await this.app.vault.create(path,content);}catch(e){if(!this.app.vault.getAbstractFileByPath(path))throw e;}}}
  async createSubmission(form,answers){
    validateForm(copy(form));const folders=await this.inboxes();const folder=folders.get(form.folderId);if(!folder)throw Error('Choose an inbox in Edit form before submitting.');
    const sender=String(answers[form.fields.find(f=>f.role==='sender').id]??'').trim();
    const subject=String(answers[form.fields.find(f=>f.role==='subject').id]??'').trim();if(!sender||!subject)throw Error('Sender and subject are required.');
    const now=new Date(),pad=n=>String(n).padStart(2,'0');
    const date=`${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
    const time=`${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const fm={papertrail_kind:'submission',papertrail_id:uuid(),current_inbox_id:form.folderId,visited_inboxes:[form.folderId],submitted_at:now.toISOString(),date_submitted:date,email:sender,subject};
    const normalized=validateForm(copy(form));const sections=[];
    for(const field of normalized.fields){const value=answers[field.id];
      if(field.storage==='frontmatter'&&field.role==='none')fm[field.key]=value;
      if(field.storage==='body'){
        const rendered=Array.isArray(value)?value.map(v=>`- ${v}`).join('\n'):typeof value==='boolean'?(value?'Yes':'No'):value==null?'':String(value);
        sections.push(`### ${field.label}\n\n${rendered}`);
      }
    }
    const body=`## Original submission\n\n**From:** ${line(sender)}  \n**To:** ${line(folder.path)}  \n**Date:** ${now.toLocaleString()}\n\n${sections.join('\n\n')}\n\n${ACTIONS_MARKER}\n${ACTIONS_BLOCK}\n`;
    return this.createUnique(folder.path,`${date} ${time} - ${safeName(subject)}.md`,pack(fm,body));
  }
  async entries(file){
    const fm=(await this.read(file)).fm, folders=await this.inboxes(),missing=[];
    for(const id of unique(fm.visited_inboxes||[])){
      const folder=folders.get(id);if(!folder){missing.push(id);continue;}
      let found=false;
      for(const f of this.app.vault.getMarkdownFiles().filter(x=>x.parent===folder)){
        const text=await this.app.vault.cachedRead(f);if(!text.includes(fm.papertrail_id))continue;
        try{const p=splitNote(text).fm;if(p.papertrail_kind==='inbox-link'&&p.papertrail_id===fm.papertrail_id){found=true;break;}}catch(_e){}
      }
      if(found)continue;
      const link=this.app.fileManager.generateMarkdownLink(file,`${folder.path}/placeholder.md`,undefined,'Open conversation');
      const data={papertrail_kind:'inbox-link',papertrail_id:fm.papertrail_id,inbox_folder_id:id,subject:fm.subject};
      await this.createUnique(folder.path,`${safeName(fm.subject)} - thread ${fm.papertrail_id.slice(0,8)}.md`,pack(data,`# ${safeName(fm.subject)}\n\n${link}\n\n${ACTIONS_BLOCK}\n`));
    }
    if(missing.length)new Notice(`${missing.length} previous inbox folder(s) could not be found. Restore the settings note and use Repair inbox links.`);
  }
  async promote(file){
    const fm=(await this.read(file)).fm;if(fm.papertrail_kind!=='thread')return;
    if(!fm.thread_home_set){await this.ensureFolder('Threads');const dest=await this.freePath('Threads',file.name,file);if(file.path!==dest)await this.app.fileManager.renameFile(file,dest);await this.app.fileManager.processFrontMatter(file,p=>{p.thread_home_set=true;});}
    await this.entries(file);
  }
  async applyAction(id,action){
    if(this.locks.has(id))throw Error('This conversation is already saving. Try again shortly.');this.locks.add(id);
    try{
      const file=await this.canonical(id);const fm=(await this.read(file)).fm;
      if((fm.completed_actions||[]).includes(action.id)){await this.promote(file);return file;}
      const folders=await this.inboxes(),from=folders.get(action.fromId);if(!from)throw Error('The sending inbox could not be found.');
      let target,toId;
      if(action.mode==='forward'){
        target=this.app.vault.getAbstractFileByPath(action.toPath);if(!(target instanceof TFolder))throw Error('Choose a destination inbox.');
        toId=await this.inboxId(target);if(toId===action.fromId)throw Error('Choose a different inbox.');
      }
      const bare=fm.papertrail_kind==='submission'&&action.mode==='forward'&&!action.message.trim();
      if(bare){
        await this.app.fileManager.processFrontMatter(file,p=>{p.visited_inboxes=unique([...(p.visited_inboxes||[]),action.fromId,toId]);});
        const path=await this.freePath(target.path,file.name,file);if(path!==file.path)await this.app.fileManager.renameFile(file,path);
        await this.app.fileManager.processFrontMatter(file,p=>{p.current_inbox_id=toId;p.completed_actions=unique([...(p.completed_actions||[]),action.id]);});return file;
      }
      const kind=action.mode==='reply'?'Reply':action.message.trim()?'Forward with message':'Forward';
      const to=action.mode==='forward'?target.path:line(action.to), timestamp=new Date();
      const addition=`\n\n---\n\n## ${kind}\n\n**From:** ${line(action.sender)||from.path}  \n**To:** ${line(to)}  \n**Date:** ${timestamp.toLocaleString()}\n\n${action.message.trim()||'_Forwarded without an additional message._'}\n`;
      await this.app.vault.process(file,text=>{
        const doc=splitNote(text);if((doc.fm.completed_actions||[]).includes(action.id))return text;
        const index=doc.body.lastIndexOf(ACTIONS_MARKER);if(index<0)throw Error('The conversation action marker is missing; restore it before adding messages.');
        doc.fm.papertrail_kind='thread';doc.fm.visited_inboxes=unique([...(doc.fm.visited_inboxes||[]),action.fromId,toId]);doc.fm.completed_actions=unique([...(doc.fm.completed_actions||[]),action.id]);doc.fm.last_updated=timestamp.toISOString();
        return pack(doc.fm,doc.body.slice(0,index).trimEnd()+addition+'\n'+doc.body.slice(index));
      });
      await this.promote(file);return file;
    }finally{this.locks.delete(id);}
  }
  async renderActions(el,path){
    try{
      const entry=this.app.vault.getAbstractFileByPath(path);if(!(entry instanceof TFile))return;
      const info=(await this.read(entry)).fm;if(!info.papertrail_id)return;
      const row=el.createDiv({cls:'pt-actions'});const error=el.createEl('p',{cls:'pt-error'});
      if(info.papertrail_kind==='inbox-link')button(row,'Open thread',async()=>{try{const file=await this.canonical(info.papertrail_id);await this.app.workspace.getLeaf(false).openFile(file);}catch(e){showError(error,e);}},'mod-cta');
      for(const mode of ['reply','forward'])button(row,mode==='reply'?'Reply':'Forward',()=>new ActionModal(this,info.papertrail_id,info.inbox_folder_id,mode).open());
      const file=await this.canonical(info.papertrail_id),fm=(await this.read(file)).fm;
      if(fm.papertrail_kind==='thread')button(row,'Repair inbox links',async()=>{try{await this.promote(await this.canonical(info.papertrail_id));new Notice('Inbox links checked.');}catch(e){showError(error,e);}});
    }catch(e){el.createEl('p',{text:errorText(e),cls:'pt-error'});}
  }
};

class FormsModal extends Modal {
  constructor(plugin){super(plugin.app);this.plugin=plugin;}
  onOpen(){this.render();}
  render(){
    const root=this.contentEl;root.empty();root.addClass('pt-modal');
    root.createEl('h2',{text:'Papertrail Forms'});
    root.createEl('p',{text:'Create a form, choose an inbox, then open the form whenever you want to add a submission.',cls:'pt-muted'});
    const list=root.createDiv({cls:'pt-form-list'});
    if(!this.plugin.data.forms.length)list.createEl('p',{text:'No forms yet. Create your first one to get started.',cls:'pt-empty'});
    for(const form of this.plugin.data.forms){
      const card=list.createDiv({cls:'pt-form-card'}),head=card.createDiv({cls:'pt-card-heading'});
      head.createEl('strong',{text:form.name});
      if(this.plugin.data.activeFormId===form.id)head.createEl('span',{text:'Active',cls:'pt-badge'});
      card.createEl('p',{text:`${form.fields.length} field${form.fields.length===1?'':'s'}`,cls:'pt-muted'});
      const actions=card.createDiv({cls:'pt-actions'});
      button(actions,'Fill out',async()=>{this.plugin.data.activeFormId=form.id;await this.plugin.persist();this.close();new FillModal(this.plugin,form).open();},'mod-cta');
      button(actions,'Embed in current note',async()=>{this.close();await this.plugin.insertForm(form);});
      button(actions,'Edit',()=>{this.close();new FormEditorModal(this.plugin,form).open();});
      button(actions,'Duplicate',async()=>{try{const next=copy(form);next.id=uuid();next.name=`${form.name} copy`;this.plugin.data.forms.push(next);await this.plugin.persist();this.render();}catch(e){new Notice(errorText(e));}});
      button(actions,'Delete',()=>new ConfirmModal(this.app,`Delete the form “${form.name}”? Existing submissions and threads will stay in the vault.`,async()=>{
        this.plugin.data.forms=this.plugin.data.forms.filter(f=>f.id!==form.id);if(this.plugin.data.activeFormId===form.id)this.plugin.data.activeFormId=this.plugin.data.forms[0]?.id||'';await this.plugin.persist();this.render();
      }).open());
    }
    button(root,'Create form',()=>{this.close();new FormEditorModal(this.plugin,newForm(),true).open();},'mod-cta pt-create');
  }
  onClose(){this.contentEl.empty();}
}
class ConfirmModal extends Modal {
  constructor(app,text,yes){super(app);this.text=text;this.yes=yes;}
  onOpen(){this.contentEl.createEl('h2',{text:'Delete form?'});this.contentEl.createEl('p',{text:this.text});const row=this.contentEl.createDiv({cls:'pt-actions'});button(row,'Delete',async()=>{try{await this.yes();this.close();}catch(e){new Notice(errorText(e));}},'mod-warning');button(row,'Cancel',()=>this.close());}
  onClose(){this.contentEl.empty();}
}
class FormEditorModal extends Modal {
  constructor(plugin,form,isNew=false){super(plugin.app);this.plugin=plugin;this.draft=copy(form);this.isNew=isNew;this.isSaving=false;}
  onOpen(){this.render().catch(e=>new Notice(errorText(e)));}
  async render(){
    const root=this.contentEl;root.empty();root.addClass('pt-modal');root.createEl('h2',{text:this.isNew?'Create form':'Edit form'});
    root.createEl('p',{text:'Choose fields and where their answers go. Sender and subject identify the correspondence.',cls:'pt-muted'});
    this.error=root.createEl('p',{cls:'pt-error',attr:{role:'alert'}});
    const name=labelInput(root,'Form name');name.value=this.draft.name;name.addEventListener('input',()=>{this.draft.name=name.value;});
    const inboxes=await this.plugin.inboxes();const choices=[['','Choose an inbox…'],...this.plugin.folders().map(f=>[f.path,f.path])];
    const picker=selectInput(root,'Save submissions to',choices,inboxes.get(this.draft.folderId)?.path||'');
    picker.addEventListener('change',async()=>{
      try{const folder=this.app.vault.getAbstractFileByPath(picker.value);if(!folder){this.draft.folderId='';return;}picker.disabled=true;this.draft.folderId=await this.plugin.inboxId(folder);this.error.textContent='';}
      catch(e){this.draft.folderId='';showError(this.error,e);}finally{picker.disabled=false;}
    });
    const createRow=root.createDiv({cls:'pt-create-inbox'});
    const character=labelInput(createRow,'Create a character inbox');character.placeholder='Character name, e.g. Paul';
    button(createRow,'Create inbox',async()=>{
      const name=line(character.value);if(!name||/[\\/:*?"<>|\u0000-\u001f]/.test(name)){this.error.textContent='Enter a name without / \\ : * ? " < > |';return;}
      try{const folder=await this.plugin.ensureFolder(normalizePath(`${name}'s Inbox`));this.draft.folderId=await this.plugin.inboxId(folder);await this.render();}
      catch(e){showError(this.error,e);}
    });
    this.cards=root.createDiv({cls:'pt-fields'});this.renderCards();
    const bottom=root.createDiv({cls:'pt-actions pt-bottom'});
    button(bottom,'Add field',()=>{const f=newField();this.draft.fields.push(f);this.renderCards(f.id);});
    const save=button(bottom,'Save form',async()=>{
      if(this.isSaving)return;this.isSaving=true;save.disabled=true;
      try{
        const next=validateForm(copy(this.draft));const folders=await this.plugin.inboxes();if(!folders.has(next.folderId))throw Error('Choose an inbox for submissions.');
        const index=this.plugin.data.forms.findIndex(f=>f.id===next.id);
        if(index<0)this.plugin.data.forms.push(next);else this.plugin.data.forms[index]=next;
        this.plugin.data.activeFormId=next.id;await this.plugin.persist();this.close();new FormsModal(this.plugin).open();
      }catch(e){showError(this.error,e);}finally{this.isSaving=false;save.disabled=false;}
    },'mod-cta');
    button(bottom,'Cancel',()=>{this.close();new FormsModal(this.plugin).open();});
    root.createEl('p',{text:'Sender and subject are required and stored in note properties for Reply and Forward. Changes apply to future submissions.',cls:'pt-muted'});
  }
  renderCards(activeId){
    this.cards.empty();const fields=this.draft.fields;
    fields.forEach((field,index)=>{
      const details=this.cards.createEl('details',{cls:'pt-field-card'});details.open=field.id===activeId;
      const summary=details.createEl('summary',{text:`${index+1}. ${field.label||'Untitled field'} · ${TYPES[field.type]||'Field'}`});
      details.addEventListener('toggle',()=>{if(details.open)for(const sibling of this.cards.children)if(sibling!==details)sibling.open=false;});
      const inner=details.createDiv({cls:'pt-field-settings'});
      const label=labelInput(inner,'Label');label.value=field.label;label.addEventListener('input',()=>{field.label=label.value;summary.textContent=`${index+1}. ${field.label||'Untitled field'} · ${TYPES[field.type]}`;});
      const type=selectInput(inner,'Input type',Object.entries(TYPES),field.type);type.addEventListener('change',()=>{field.type=type.value;this.renderCards(field.id);});
      const placeholder=labelInput(inner,'Placeholder (optional)');placeholder.value=field.placeholder||'';placeholder.addEventListener('input',()=>{field.placeholder=placeholder.value;});
      const requiredWrap=inner.createEl('label',{cls:'pt-check-line'}),required=requiredWrap.createEl('input');required.type='checkbox';required.checked=!!field.required;
      requiredWrap.createEl('span',{text:'Required'});required.addEventListener('change',()=>{field.required=required.checked;});
      const storage=selectInput(inner,'Include answer in',[['body','Note body'],['frontmatter','Note properties (frontmatter)']],field.storage);storage.addEventListener('change',()=>{field.storage=storage.value;});
      const role=selectInput(inner,'Correspondence role',Object.entries(ROLE_LABELS),field.role);role.addEventListener('change',()=>{field.role=role.value;});
      if(['select','checkboxes'].includes(field.type)){
        const choices=labelInput(inner,'Choices (one per line)','textarea');choices.rows=5;choices.value=(field.options||[]).join('\n');choices.addEventListener('input',()=>{field.options=choices.value.split(/\r?\n/);});
      }
      const actions=inner.createDiv({cls:'pt-actions'});
      for(const [title,delta] of [['Move up',-1],['Move down',1]]){
        const b=button(actions,title,()=>{[fields[index],fields[index+delta]]=[fields[index+delta],fields[index]];this.renderCards(field.id);});b.disabled=index+delta<0||index+delta>=fields.length;
      }
      button(actions,'Remove',()=>{fields.splice(index,1);this.renderCards(fields[Math.min(index,fields.length-1)]?.id);});
    });
  }
  onClose(){this.contentEl.empty();}
}
class FillModal extends Modal {
  constructor(plugin,form,embeddedRoot=null){super(plugin.app);this.plugin=plugin;this.form=copy(form);this.embeddedRoot=embeddedRoot;}
  onOpen(){this.render().catch(e=>{this.contentEl.createEl('p',{text:errorText(e),cls:'pt-error'});});}
  async render(){
    const form=validateForm(this.form),root=this.embeddedRoot||this.contentEl;root.empty();root.addClass(this.embeddedRoot?'pt-embedded':'pt-modal');root.createEl('h2',{text:form.name});
    const folders=await this.plugin.inboxes(),folder=folders.get(form.folderId);root.createEl('p',{text:folder?`Submitting to ${folder.path}`:'Choose an inbox in Edit form before submitting.',cls:'pt-muted'});
    const panel=root.createEl('form',{cls:'pt-fill-form'});const getters=new Map();
    for(const f of form.fields){
      if(f.type==='checkboxes'){
        const group=panel.createEl('fieldset',{cls:'pt-checkboxes'});group.createEl('legend',{text:f.label+(f.required?' *':'')});const choices=[];
        for(const name of f.options){const row=group.createEl('label',{cls:'pt-check-line'}),c=row.createEl('input');c.type='checkbox';row.createEl('span',{text:name});choices.push([c,name]);}
        getters.set(f.id,()=>choices.filter(([c])=>c.checked).map(([,value])=>value));continue;
      }
      if(f.type==='checkbox'){
        const wrap=panel.createEl('label',{cls:'pt-check-line'}),input=wrap.createEl('input');input.type='checkbox';input.required=f.required;wrap.createEl('span',{text:f.label+(f.required?' *':'')});getters.set(f.id,()=>input.checked);continue;
      }
      const tag=f.type==='textarea'?'textarea':f.type==='select'?'select':'input';const input=labelInput(panel,f.label+(f.required?' *':''),tag,f.type);
      input.required=f.required;input.placeholder=f.placeholder||'';
      if(f.type==='number')input.step='any';if(f.type==='textarea')input.rows=7;
      if(f.type==='select'){input.createEl('option',{text:'Choose…',value:''});for(const opt of f.options)input.createEl('option',{text:opt,value:opt});}
      getters.set(f.id,()=>f.type==='number'?(input.value===''?null:Number(input.value)):input.value.trim());
    }
    const error=panel.createEl('p',{cls:'pt-error',attr:{role:'alert'}});const status=panel.createEl('p',{cls:'pt-muted',attr:{role:'status'}});const row=panel.createDiv({cls:'pt-actions'});
    const submit=row.createEl('button',{text:'Submit',cls:'mod-cta'});submit.type='submit';button(row,'Manage forms',()=>{if(!this.embeddedRoot)this.close();new FormsModal(this.plugin).open();});
    let busy=false;panel.addEventListener('submit',async event=>{
      event.preventDefault();if(busy||!panel.reportValidity())return;
      const answers={};for(const f of form.fields){const value=getters.get(f.id)();const empty=value===null||value===''||(Array.isArray(value)&&!value.length)||(f.type==='checkbox'&&!value);
        if(f.required&&empty){error.textContent=`Please fill in “${f.label}”.`;return;}if(typeof value==='number'&&!Number.isFinite(value)){error.textContent=`Enter a valid number for “${f.label}”.`;return;}answers[f.id]=value;}
      busy=true;submit.disabled=true;error.textContent='';status.textContent='';
      try{const file=await this.plugin.createSubmission(form,answers);new Notice(`Saved to ${file.parent.path}.`);
        if(this.embeddedRoot){panel.reset();status.textContent=`Saved: ${file.path}`;}
        else{this.close();await this.app.workspace.getLeaf(false).openFile(file);}}
      catch(e){showError(error,e);}finally{busy=false;submit.disabled=false;}
    });
  }
  onClose(){this.contentEl.empty();}
}
class ActionModal extends Modal {
  constructor(plugin,id,entryInbox,mode){super(plugin.app);this.plugin=plugin;this.id=id;this.entryInbox=entryInbox;this.mode=mode;this.operationId=uuid();}
  onOpen(){this.render().catch(e=>this.contentEl.createEl('p',{text:errorText(e),cls:'pt-error'}));}
  async render(){
    const file=await this.plugin.canonical(this.id),fm=(await this.plugin.read(file)).fm,folders=await this.plugin.inboxes();
    const root=this.contentEl;root.empty();root.addClass('pt-modal');root.createEl('h2',{text:this.mode==='reply'?'Reply':'Forward'});root.createEl('p',{text:fm.subject||'Conversation',cls:'pt-muted'});
    const panel=root.createEl('form',{cls:'pt-fill-form'});
    const fromChoices=unique(fm.visited_inboxes||[]).filter(id=>folders.has(id)).map(id=>[id,folders.get(id).path]);
    const from=selectInput(panel,this.mode==='reply'?'Reply from inbox':'Forward from inbox',fromChoices,this.entryInbox||fm.current_inbox_id||fromChoices.at(-1)?.[0]||'');from.required=true;
    const sender=labelInput(panel,'From (character name or email)');sender.required=true;
    const updateSender=()=>{sender.value=(folders.get(from.value)?.path.split('/').pop()||'').replace(/(?:’s|'s) Inbox$/i,'');};updateSender();from.addEventListener('change',updateSender);
    let to;if(this.mode==='reply'){to=labelInput(panel,'To (name or email)');to.value=fm.email||'';}
    else to=selectInput(panel,'Destination inbox',[['','Choose an inbox…'],...this.plugin.folders().map(f=>[f.path,f.path])],'');
    to.required=true;
    const message=labelInput(panel,this.mode==='reply'?'Message':'Message (optional)','textarea');message.rows=8;message.required=this.mode==='reply';
    if(this.mode==='forward')panel.createEl('p',{text:'A forward with a message starts a thread. A plain forward moves a standalone submission.',cls:'pt-muted'});
    const error=panel.createEl('p',{cls:'pt-error',attr:{role:'alert'}});const row=panel.createDiv({cls:'pt-actions'});
    const save=row.createEl('button',{text:this.mode==='reply'?'Save reply':'Forward',cls:'mod-cta'});save.type='submit';button(row,'Cancel',()=>this.close());
    let busy=false;panel.addEventListener('submit',async event=>{
      event.preventDefault();if(busy||!panel.reportValidity())return;
      if(this.mode==='reply'&&!message.value.trim()){error.textContent='Write a message before replying.';return;}
      busy=true;save.disabled=true;
      try{
        const updated=await this.plugin.applyAction(this.id,{id:this.operationId,mode:this.mode,fromId:from.value,sender:sender.value,to:to.value,toPath:to.value,message:message.value});
        this.close();new Notice(this.mode==='reply'?'Reply saved.':'Forwarded.');await this.app.workspace.getLeaf(false).openFile(updated);
      }catch(e){error.textContent=`${errorText(e)} Your message is still here. You can retry.`;save.textContent='Retry';}finally{busy=false;save.disabled=false;}
    });
  }
  onClose(){this.contentEl.empty();}
}
