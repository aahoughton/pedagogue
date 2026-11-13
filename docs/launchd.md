# Running the daemon at login (macOS)

launchd can start the daemon when you log in and restart it if it exits. The
daemon reads its settings from `~/.config/pedagogue/env` as usual.

## Install

Run this from the repository root. It writes a launch agent with this
checkout's path and your home directory filled in, then loads it.

```sh
REPO=$(pwd)
MISE_DIR=$(dirname "$(command -v mise)")
PLIST=~/Library/LaunchAgents/dev.pedagogue.daemon.plist

cat > "$PLIST" <<PLIST_END
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.pedagogue.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>$REPO/bin/pedagogue-daemon</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$MISE_DIR:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>$HOME/Library/Logs/pedagogue.log</string>
  <key>StandardErrorPath</key>
  <string>$HOME/Library/Logs/pedagogue.log</string>
</dict>
</plist>
PLIST_END

launchctl bootstrap gui/$(id -u) "$PLIST"
```

The agent runs `bin/pedagogue-daemon`, which starts the daemon with
`mise exec` so that it gets the Node version `mise.toml` pins. launchd does not
have your shell's `PATH`, only the system directories, so the agent sets a
`PATH` that includes the directory where `mise` is installed.

## Check

```sh
launchctl print gui/$(id -u)/dev.pedagogue.daemon | grep -E "state|last exit"
tail ~/Library/Logs/pedagogue.log
```

The log should end with the `listening on` lines.

## After changing code or settings

```sh
launchctl kickstart -k gui/$(id -u)/dev.pedagogue.daemon
```

## Remove

```sh
launchctl bootout gui/$(id -u)/dev.pedagogue.daemon
rm ~/Library/LaunchAgents/dev.pedagogue.daemon.plist
```

## Things to know

- macOS names a launch agent after the program it runs. System Settings >
  General > Login Items & Extensions and the "can run in the background"
  notice show this one as `pedagogue-daemon`. Switching it off there stops the
  daemon from starting at login.
- An agent installed before `bin/pedagogue-daemon` existed runs `mise`
  directly and is listed as `mise`. Run Remove and then Install to replace it.
- If `mise` moves (for example after reinstalling it another way), the daemon
  exits with "mise not found on PATH". Run Remove and then Install again.

- If `PEDAGOGUE_HOST` includes a tailnet address and Tailscale is not up yet at
  login, the daemon exits with "cannot listen" and launchd starts it again
  every 10 seconds until the address exists.
- A missing or unreadable settings file, or a missing API key, also makes the
  daemon exit, so it will restart in a loop. The log says which.
- Do not run `pnpm start` while the agent is loaded; the second daemon cannot
  take the port.
