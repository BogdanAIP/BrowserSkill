# BrowserSkill ChatGPT bridge

Local MCP bridge between ChatGPT and Tencent BrowserSkill.

## Stable baseline

The initial working local bridge is preserved on:

- branch: `main`
- tag: `baseline-before-browser-workflow`

The `feature/browser-workflow` branch adds a higher-level browser workflow without removing the original low-level MCP tools.

## High-level workflow

Normal browser tasks should prefer:

1. `browser_acquire`
2. one or more `browser_act` calls
3. `browser_release`

`browser_acquire`:

- requires exactly one connected BrowserSkill browser;
- resolves its exact BrowserSkill instance id internally;
- starts a BrowserSkill session;
- lists existing user tabs;
- borrows a matching existing tab when possible;
- otherwise opens the supplied fallback URL;
- returns the initial semantic observation.

`browser_act` supports the same major capability families as the existing low-level tools:

- observe, snapshot, HTML, screenshot, console, network;
- navigate, back, forward, reload, wait;
- click, hover, wheel, scroll, focus, blur, fill, select, press;
- list/create/select/close/borrow/return tabs;
- resize, emulate, request human help;
- upload, drop-upload, download.

Actions are explicit in the tool arguments. If a batch partially succeeds, completed actions are reported separately from the failed step so a write action is not blindly repeated after an observation or later step fails.

`browser_release` explicitly returns borrowed tabs and stops the BrowserSkill session.

The original seven low-level tools remain available as a fallback.

## Local checks

Run:

    npm test

This checks JavaScript syntax and verifies that the MCP server exposes all expected tools. It does not require a browser connection.

A real BrowserSkill/browser smoke test still requires the local BrowserSkill extension and daemon.

## Rollback

Nothing in `main` needs to change while this feature is tested.

To return a local checkout to the original baseline:

    git fetch --all --tags
    git switch main
    git reset --hard baseline-before-browser-workflow

Do not use the reset command if there are uncommitted local changes you want to keep.
