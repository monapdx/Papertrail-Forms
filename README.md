# Papertrail Forms

<img src="https://raw.githubusercontent.com/monapdx/Papertrail-Forms/refs/heads/main/banner.png">

Create forms inside Obsidian and use them to build a fictional inbox and correspondence workflow. Everything stays in your vault. The plugin does not send real email. 

This plugin was developed as a tool to help authors using my **fiction writing** system called *[The Papertrail Method](https://github.com/monapdx/The-Papertrail-Method)*.

## Install

1. Extract the ZIP. Inside is the `papertrail-forms` folder.
2. Open your Obsidian vault folder. Copy `papertrail-forms` into `.obsidian/plugins/`.
   - On Windows, turn on **Hidden items** in File Explorer if you cannot see `.obsidian`.
   - If `plugins` does not exist, create that folder inside `.obsidian`.
3. Restart Obsidian or reload the app.
4. Open **Settings → Community plugins**, turn off Restricted mode if necessary, and enable **Papertrail Forms**.
5. Click the mail icon on the ribbon, or run **Papertrail Forms: Open forms** from the command palette.

## Create a form

1. Click **Create form**. Give it a name.
2. Pick an existing folder for submissions, or type a character name and click **Create inbox**.
3. Edit the default fields. Expand a field to change its label, type, required setting, and where the answer goes. Use **Add field** for more fields.
4. Assign exactly one field the **Sender** role and one the **Subject** role. They are required and stored in note properties to make replies and threads work.
5. Save the form, then choose **Fill out**. You can create, duplicate, edit, or delete forms from the manager.

Choose short text, email, long text, dropdown, a checkbox group, a single checkbox, number, or date. Dropdown and checkbox group choices go one per line. Deleting a form does not delete its existing submissions.

Each chosen inbox contains a small `_Inbox Settings.md` note. Keep it in that folder, with its filename unchanged. It gives the inbox a stable identity, so forms and threads can still find the inbox if you rename or move the folder.

## Submissions, forwards, and threads

- A new submission appears in its chosen inbox. Open it in **Reading view** to see **Reply** and **Forward** buttons below the message.
- Forwarding a standalone submission without a message moves that note to another inbox.
- A reply or a forward with a message starts a thread: the original note moves into `Threads`, and the message is added to it.
- Once a thread exists, each inbox that received the submission has an entry that opens the same shared thread. Forwarding the thread adds a destination entry, keeping earlier entries.
- A thread includes **Repair inbox links** to recreate missing entries when its inbox settings notes can be found.
- You can also use the command palette commands **Reply to current submission or thread** and **Forward current submission or thread**.

Leave the small `papertrail-actions` code block and the `papertrail-actions` HTML comment in generated notes; they locate and display the buttons. Notes remain readable Markdown if the plugin is disabled, though the interactive controls will not run.

## Data and testing

Form definitions are stored in the plugin's `data.json` in your vault's configuration folder. Submissions and threads are Markdown notes inside your vault. The plugin does not connect to an email provider or send messages over the internet.

This is an initial release. Test it in a test vault before relying on it for important work, and keep normal vault backups.
