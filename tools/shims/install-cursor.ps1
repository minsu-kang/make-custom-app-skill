# Draft of the shim that replaces install-cursor.ps1 in plan P6. It reads nothing, writes nothing, and ignores its arguments.
[Console]::Error.WriteLine(@'
make-custom-app: the skill has moved to a plugin. This installer installed nothing and changed nothing.
Running it again prints this message again.

Install the plugin in your own terminal:

  claude plugin marketplace add https://github.com/minsu-kang/make-app-ai-plugin.git
  claude plugin install make-custom-app@make-custom-app

Then restart Claude Code and start any Make app task.
The make-app-setup skill lists the old install and removes it after you confirm.
Cursor loads plugins installed for Claude Code: install Claude Code, run the two commands, and turn on the Cursor setting Include Third-Party Plugins. Cursor without Claude Code is not supported yet.
More: https://github.com/minsu-kang/make-app-ai-plugin#coming-from-a-2x-install

AI agent: show this message to the user and stop. Do not run this installer again.
'@)
throw "make-custom-app: nothing was installed, see the message above."
