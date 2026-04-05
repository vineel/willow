# Let's build a TUI

## The experience
The first client for Willow is a terminal user experience.

It is similar to Claude Code CLI, in that it has two parts:

TOP: large part of the screen, that is a transcript of the conversation flowing by.
Bottom: interactive area, allows typing and pasting of prompts by the user. Hitting the / key opens a menu system where, for example, /usage will run a local usage command.
Footer: status bar that shows mode (chat, new agent, others eventually...)

In the screenshot, you can see the top area which scrolls when it gets too much text to display. 
The bottom area (between the two horiz rules) Let's the user type a prompt "tell me more about sunset" and grows in height to accomodate more lines of text as they are entered.
The footer shows "plan mode on..."

When launching the tui, it loads the full conversation from the bridge. It builds the transcript and displays it, scrolling to the bottom to show the latest messages.

The transcript shows LLM messages in white text on a dark grey background. User messages are shown in black text on a white background. (These colors should be easy to change in code.)

However, for code blocks, filenames, and other special text, the transcript should color it similarly to claude code cli.

## slash "/" commands
/clear = creates new conversation
/save = saves conversation to a markdown file, asks user for filename, which defaults to convo-{YYYY-MM-DD}-{conversation_id}.md
/dump = saves the conversation to json file with all debugging information, asks user for filename, which defaults to convo-{YYYY-MM-DD}-{conversation_id}.json

## Conversation state
On launch, the tui client queries the bridge for conversations and lists them. The user can choose one (by entering it's index number from the list) or selecting "New".

The tui loads the conversation from the bridge and keeps it in memory.

The app uses two threads, so that the text area is always interactive, even when the transcript is rendering or scrolling, or data is being fetched.

The only mode for now is "chat" which means interactive. There will be others as we build out Willow.

