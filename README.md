# Twitch Chat Bot

A simple and extensible Twitch chat bot built with Node.js using the tmi.js library.

## Features

- 🤖 Connect to multiple Twitch channels simultaneously
- 💬 Respond to chat commands
- 🎲 Built-in commands (dice roll, uptime, greetings)
- 🔧 Easy to configure with environment variables
- 📝 Extensible command system

## Prerequisites

- [Node.js](https://nodejs.org/) (v14 or higher recommended)
- A Twitch account for your bot
- OAuth token for Twitch IRC

## Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/boyphongsakorn/twitchchatbot.git
   cd twitchchatbot
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure the bot**
   - Copy `.env.example` to `.env`:
     ```bash
     cp .env.example .env
     ```
   - Edit `.env` and fill in your credentials:
     - `TWITCH_USERNAME`: Your bot's Twitch username (lowercase)
     - `TWITCH_OAUTH_TOKEN`: OAuth token from [https://twitchapps.com/tmi/](https://twitchapps.com/tmi/)
     - `TWITCH_CHANNELS`: Comma-separated list of channels to join (without #)

4. **Get OAuth Token**
   - Visit [https://twitchapps.com/tmi/](https://twitchapps.com/tmi/)
   - Login with your bot's Twitch account
   - Copy the OAuth token (including the `oauth:` prefix)

## Usage

**Start the bot:**
```bash
npm start
```

The bot will connect to Twitch and join the specified channels.

## Available Commands

Users can interact with the bot using these commands in chat:

- `!hello` or `!hi` - Bot greets the user
- `!dice` - Roll a 6-sided dice
- `!uptime` - Shows how long the bot has been running
- `!commands` or `!help` - Lists available commands

## Adding Custom Commands

To add new commands, edit `index.js` and add cases to the `handleCommand` function:

```javascript
case 'yourcommand':
  client.say(channel, `Response to @${tags.username}`);
  break;
```

## Project Structure

```
twitchchatbot/
├── index.js          # Main bot application
├── package.json      # Node.js dependencies and scripts
├── .env.example      # Example environment configuration
├── .env              # Your actual configuration (not tracked by git)
└── README.md         # This file
```

## Configuration Options

Edit `.env` file:

- `TWITCH_USERNAME` - Bot's username
- `TWITCH_OAUTH_TOKEN` - OAuth token for authentication
- `TWITCH_CHANNELS` - Channels to join (comma-separated)
- `DEBUG` - Enable debug logging (true/false)

## Troubleshooting

**Bot doesn't connect:**
- Verify your OAuth token is correct and includes the `oauth:` prefix
- Check that your bot's username is lowercase
- Ensure your bot account has verified email

**Bot doesn't respond to commands:**
- Make sure commands start with `!`
- Check that the bot has joined the channel successfully
- Verify the bot isn't ignoring its own messages (the `self` check in code)

## Dependencies

- [tmi.js](https://github.com/tmijs/tmi.js) - Twitch IRC client
- [dotenv](https://github.com/motdotla/dotenv) - Environment variable management

## License

ISC

## Contributing

Feel free to submit issues and pull requests!