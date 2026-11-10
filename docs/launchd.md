# Running the daemon at login (macOS)

launchd can start the daemon when you log in and restart it if it exits. The
daemon reads its settings from `~/.config/pedagogy/env` as usual.

## Install

Run this from the repository root. It writes a launch agent with this
checkout's path and your home directory filled in, then loads it.

```sh
REPO=$(pwd)
MISE=$(command -v mise)
PLIST=~/Library/LaunchAgents/dev.pedagogy.daemon.plist

cat > "$PLIST" <<PLIST_END
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.pedagogy.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>$MISE</string>
    <string>exec</string>
    <string>--</string>
    <string>node</string>
    <string>src/daemon/main.ts</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$REPO</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>$HOME/Library/Logs/pedagogy.log</string>
  <key>StandardErrorPath</key>
  <string>$HOME/Library/Logs/pedagogy.log</string>
</dict>
</plist>
PLIST_END

launchctl bootstrap gui/$(id -u) "$PLIST"
```

`mise exec` runs the Node version that `mise.toml` pins, without depending on
your shell's `PATH`, which launchd does not have.

## Check

```sh
launchctl print gui/$(id -u)/dev.pedagogy.daemon | grep -E "state|last exit"
tail ~/Library/Logs/pedagogy.log
```

The log should end with the `listening on` lines.

## After changing code or settings

```sh
launchctl kickstart -k gui/$(id -u)/dev.pedagogy.daemon
```

## Remove

```sh
launchctl bootout gui/$(id -u)/dev.pedagogy.daemon
rm ~/Library/LaunchAgents/dev.pedagogy.daemon.plist
```

## Things to know

- If `PEDAGOGY_HOST` includes a tailnet address and Tailscale is not up yet at
  login, the daemon exits with "cannot listen" and launchd starts it again
  every 10 seconds until the address exists.
- A missing or unreadable settings file, or a missing API key, also makes the
  daemon exit, so it will restart in a loop. The log says which.
- Do not run `pnpm start` while the agent is loaded; the second daemon cannot
  take the port.
