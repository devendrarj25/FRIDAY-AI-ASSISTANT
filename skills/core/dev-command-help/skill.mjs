// FRIDAY · skill: dev-command-help
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Explain commands, git recipes, Windows shortcuts and Run commands. A reference desk for the command line and for Windows itself.
// It holds 3 small tools (parts). A request that names one runs it; otherwise every tool whose topic matches the
// request runs, the first answer is the main result and the others are listed under "also". Pass part to pick one.

const PARTS = [
  {
    id: "explain-command",
    gate: /explain|what does|what is this|meaning of|flags?|options|`|\bmeans?\b/,
    run: (() => {
      // Command explainer: what a git, docker, npm, pip, winget, PowerShell, cmd or Linux command does, flag by flag, with danger warnings.
      const T = {
        git: {
          d: "Version control",
          sub: {
            status: "Show changed, staged and untracked files",
            add: "Stage changes for the next commit",
            commit: "Record staged changes as a commit",
            push: "Send commits to the remote",
            pull: "Fetch the remote and merge it into this branch",
            fetch: "Download remote changes without merging",
            merge: "Join another branch into this one",
            rebase: "Replay this branch's commits on top of another base (rewrites history)",
            checkout: "Switch branch or restore files",
            switch: "Switch branch",
            restore: "Restore working files from the index or a commit",
            reset: "Move the branch pointer, optionally discarding changes",
            stash: "Shelve uncommitted changes",
            log: "Show commit history",
            diff: "Show changes",
            branch: "List, create or delete branches",
            tag: "Mark a commit",
            clone: "Copy a remote repository",
            init: "Create a repository",
            remote: "Manage remote repositories",
            "cherry-pick": "Apply one commit onto this branch",
            revert: "Create a commit that undoes another commit",
            bisect: "Binary-search history for the commit that broke something",
            clean: "Delete untracked files",
            blame: "Show who last changed each line",
            reflog: "Show where HEAD has been (recovery)",
          },
          flags: {
            "-m": "commit message",
            "--amend": "rewrite the last commit",
            "--hard": "discard all working changes",
            "--soft": "keep changes staged",
            "--force": "overwrite the remote even if it diverged",
            "-f": "force",
            "--force-with-lease": "force only if nobody else pushed",
            "-b": "create a new branch",
            "-u": "set the upstream branch",
            "-a": "all tracked changes",
            "--no-ff": "always create a merge commit",
            "--staged": "compare the index",
            "--cached": "compare the index",
            "--oneline": "one line per commit",
            "--graph": "draw the branch graph",
            "-p": "patch mode / show diff",
            "-d": "delete (safe)",
            "-D": "delete even if unmerged",
            "--prune": "remove deleted remote branches",
            "-i": "interactive",
            "--abort": "cancel the operation",
            "--continue": "carry on after resolving conflicts",
            "-fd": "force, directories too",
            "-n": "dry run",
            "--stat": "summary of changes",
            "--all": "everything",
          },
          danger: [
            [/reset\s+.*--hard/, "discards uncommitted work for good"],
            [
              /push\s+.*(--force\b|\s-f\b)/,
              "can overwrite other people's commits; prefer --force-with-lease",
            ],
            [/clean\s+.*-\w*f/, "deletes untracked files permanently"],
            [/checkout\s+.*--\s/, "discards file changes"],
            [/rebase/, "rewrites history; never on shared branches"],
          ],
        },
        docker: {
          d: "Containers",
          sub: {
            run: "Create and start a container",
            ps: "List containers",
            images: "List images",
            build: "Build an image",
            exec: "Run a command in a running container",
            logs: "Show container output",
            stop: "Stop containers",
            rm: "Remove containers",
            rmi: "Remove images",
            pull: "Download an image",
            push: "Upload an image",
            compose: "Run multi-container setups",
            prune: "Delete unused data",
            system: "System-wide operations",
            volume: "Manage volumes",
            network: "Manage networks",
          },
          flags: {
            "-d": "run in the background",
            "-p": "publish port host:container",
            "-v": "mount a volume host:container",
            "--rm": "delete the container when it exits",
            "-it": "interactive terminal",
            "--name": "give the container a name",
            "-t": "tag the image (build) or allocate a terminal",
            "-f": "follow output / choose a file / force",
            "--build": "rebuild images",
            "-e": "set an environment variable",
            "--all": "everything",
            "-a": "all",
          },
          danger: [
            [/prune/, "deletes unused containers, images or volumes"],
            [/rm\s+.*-f/, "force-removes running containers"],
            [/volume\s+rm|-v\b.*down|down\s+.*-v/, "can delete stored data"],
          ],
        },
        npm: {
          d: "Node package manager",
          sub: {
            install: "Install dependencies",
            i: "Install dependencies",
            ci: "Clean install from the lockfile",
            run: "Run a package script",
            test: "Run tests",
            start: "Run the start script",
            publish: "Publish the package",
            audit: "Check dependencies for known vulnerabilities",
            outdated: "List outdated packages",
            update: "Update packages",
            uninstall: "Remove a package",
            init: "Create package.json",
            exec: "Run a package binary",
            link: "Link a local package",
          },
          flags: {
            "-g": "global install",
            "--global": "global install",
            "-D": "as a dev dependency",
            "--save-dev": "as a dev dependency",
            "--force": "ignore safety checks",
            "--legacy-peer-deps": "skip peer dependency conflicts",
            "--omit": "skip dependency types",
            fix: "apply safe fixes",
          },
          danger: [
            [/publish/, "makes the package public"],
            [/audit\s+fix\s+--force/, "may install breaking versions"],
          ],
        },
        pip: {
          d: "Python package manager",
          sub: {
            install: "Install packages",
            uninstall: "Remove packages",
            freeze: "List installed versions",
            list: "List installed packages",
            show: "Describe a package",
            download: "Download without installing",
            check: "Verify dependencies",
          },
          flags: {
            "-r": "from a requirements file",
            "--upgrade": "upgrade to the newest version",
            "-U": "upgrade",
            "-e": "editable install of a local project",
            "--user": "install for this user only",
            "--no-cache-dir": "skip the cache",
            "--break-system-packages": "override the system-Python protection",
          },
          danger: [[/--break-system-packages/, "can break the operating system's Python"]],
        },
        winget: {
          d: "Windows Package Manager",
          sub: {
            install: "Install a package",
            upgrade: "Upgrade packages",
            list: "List installed packages",
            search: "Search the catalog",
            uninstall: "Remove a package",
            show: "Describe a package",
            source: "Manage sources",
            export: "Export installed packages",
            import: "Install packages from a file",
          },
          flags: {
            "-e": "exact match",
            "--id": "package id",
            "--all": "every package",
            "--silent": "no UI",
            "-h": "silent",
            "--accept-package-agreements": "accept licences",
            "--accept-source-agreements": "accept source terms",
            "--scope": "user or machine",
          },
          danger: [[/upgrade\s+--all/, "updates everything at once; some apps may change"]],
        },
        robocopy: {
          d: "Robust file copy for Windows",
          sub: {},
          flags: {
            "/MIR": "mirror: also DELETES files in the destination that are not in the source",
            "/E": "copy subfolders including empty ones",
            "/Z": "restartable mode",
            "/R:": "retries",
            "/W:": "wait seconds between retries",
            "/MT": "multi-threaded",
            "/XD": "exclude directories",
            "/XF": "exclude files",
            "/PURGE": "delete destination files not in the source",
            "/L": "list only (dry run)",
          },
          danger: [
            [
              /\/mir|\/purge/i,
              "deletes destination files that are not in the source; test with /L first",
            ],
          ],
        },
        powershell: {
          d: "PowerShell",
          sub: {
            "get-childitem": "List files and folders (dir/ls)",
            "remove-item": "Delete files or folders",
            "get-process": "List processes",
            "stop-process": "End a process",
            "set-executionpolicy": "Change which scripts may run",
            "get-content": "Read a file",
            "set-content": "Write a file",
            "copy-item": "Copy",
            "move-item": "Move",
            "test-path": "Check if a path exists",
            "invoke-webrequest": "Download a web page or file",
            "start-process": "Start a program",
            "get-service": "List services",
            "get-help": "Show help",
          },
          flags: {
            "-recurse": "include subfolders",
            "-force": "include hidden/read-only and skip prompts",
            "-whatif": "show what would happen without doing it",
            "-confirm": "ask before acting",
            "-name": "a name filter",
            "-path": "the path",
            "-erroraction": "how to react to errors",
          },
          danger: [
            [/remove-item\s+.*-recurse/i, "deletes a whole tree; add -WhatIf first"],
            [/set-executionpolicy\s+(unrestricted|bypass)/i, "lets any script run"],
            [/stop-process\s+.*-force/i, "kills a process without saving"],
          ],
        },
        chmod: {
          d: "Change file permissions",
          sub: {},
          flags: {
            "-R": "recursive",
            755: "owner read/write/execute, others read/execute",
            644: "owner read/write, others read",
            777: "everyone can do everything",
            "+x": "make executable",
          },
          danger: [
            [/777/, "world-writable; avoid"],
            [/-R\s+.*\s\/(\s|$)/, "recursive on the root directory"],
          ],
        },
        rm: {
          d: "Delete files (Linux/macOS)",
          sub: {},
          flags: {
            "-r": "recursive",
            "-f": "no prompts",
            "-rf": "recursive and forced: no undo",
            "-i": "ask first",
          },
          danger: [[/-\w*r\w*f|-\w*f\w*r/, "permanent delete with no recycle bin"]],
        },
        curl: {
          d: "Transfer data from or to a URL",
          sub: {},
          flags: {
            "-L": "follow redirects",
            "-o": "save to a file",
            "-O": "save with the remote name",
            "-s": "silent",
            "-f": "fail on HTTP errors",
            "-X": "HTTP method",
            "-H": "add a header",
            "-d": "send data",
            "-k": "skip TLS verification (unsafe)",
            "-I": "headers only",
            "-sSL": "silent, show errors, follow redirects",
          },
          danger: [
            [
              /\|\s*(sudo\s+)?(ba)?sh/,
              "pipes a download straight into a shell: read the script first",
            ],
            [/\s-k\b|--insecure/, "turns off certificate checks"],
          ],
        },
        taskkill: {
          d: "End Windows processes",
          sub: {},
          flags: {
            "/F": "force",
            "/IM": "image (program) name",
            "/PID": "process id",
            "/T": "include child processes",
          },
          danger: [[/\/f/i, "ends the program without letting it save"]],
        },
        ipconfig: {
          d: "Show Windows network settings",
          sub: {},
          flags: {
            "/all": "full details",
            "/flushdns": "clear the DNS cache",
            "/release": "drop the DHCP address",
            "/renew": "ask for a new address",
          },
          danger: [],
        },
        netstat: {
          d: "Show network connections",
          sub: {},
          flags: {
            "-ano": "all connections, numeric, with the process id",
            "-a": "all",
            "-n": "numeric",
            "-o": "owning process id",
          },
          danger: [],
        },
        sfc: {
          d: "System File Checker",
          sub: {},
          flags: { "/scannow": "scan and repair protected system files (run as administrator)" },
          danger: [],
        },
        dism: {
          d: "Windows image servicing",
          sub: {},
          flags: {
            "/Online": "the running system",
            "/Cleanup-Image": "repair or clean the image",
            "/RestoreHealth": "repair from Windows Update",
          },
          danger: [],
        },
      };

      function findCommand(text) {
        const ticks = /`([^`]+)`/.exec(text);
        if (ticks) return ticks[1].trim();
        const after =
          /(?:explain|what does|what is|meaning of)(?:\s+this)?(?:\s+command)?\s*:?\s*(.+)$/is.exec(
            text,
          );
        const cand = (after ? after[1] : text).split(/\r?\n/).map((l) => l.trim());
        return (
          cand.find((l) =>
            Object.keys(T).some((k) => new RegExp(`^(?:sudo\\s+)?${k}\\b`, "i").test(l)),
          ) ?? null
        );
      }

      async function run(input = {}) {
        const text = String(input.command ?? input?.prompt ?? input?.text ?? "");
        const cmd = findCommand(text);
        if (!cmd)
          return {
            ok: false,
            error:
              "Paste a command (git, docker, npm, pip, winget, robocopy, PowerShell, curl, chmod ...) to explain.",
          };
        const tokens = cmd.replace(/^sudo\s+/i, "").split(/\s+/);
        const tool = tokens[0].toLowerCase().replace(/\.exe$/, "");
        const entry = T[tool] ?? T[Object.keys(T).find((k) => k === tool) ?? ""];
        const psCmd = tool.includes("-") ? T.powershell : null;
        const base = entry ?? psCmd;
        if (!base) return { ok: false, error: `I do not have "${tokens[0]}" in my command list.` };
        const subName = base === T.powershell ? tool : (tokens[1] ?? "").toLowerCase();
        const lines = [`${tokens[0]}: ${base.d}.`];
        if (base.sub[subName]) lines.push(`${subName}: ${base.sub[subName]}.`);
        const rest =
          base === T.powershell ? tokens.slice(1) : tokens.slice(base.sub[subName] ? 2 : 1);
        const flags = [];
        for (const tk of rest) {
          const key = Object.keys(base.flags).find(
            (f) =>
              f.toLowerCase() === tk.toLowerCase() ||
              (f.endsWith(":") && tk.toLowerCase().startsWith(f.toLowerCase())) ||
              (f === "755" || f === "644" || f === "777" ? tk === f : false),
          );
          if (key) flags.push(`${tk}: ${base.flags[key]}`);
        }
        const warnings = base.danger.filter(([re]) => re.test(cmd)).map(([, why]) => why);
        return {
          ok: true,
          tool: tokens[0],
          subcommand: base.sub[subName] ? subName : null,
          flags,
          warnings,
          answer: [
            ...lines,
            ...flags.map((f) => "  " + f),
            ...warnings.map((w) => "WARNING: " + w),
          ].join("\n"),
        };
      }

      return run;
    })(),
  },
  {
    id: "git-recipes",
    gate: /\bgit\b|commit|branch|stash|rebase|undo|revert|merge|push|pull|squash|blame/,
    run: (() => {
      // Git recipes: the exact commands for common situations ("undo my last commit", "I committed to the wrong branch").
      const R = [
        [
          "undo last commit keep changes staged uncommit",
          "git reset --soft HEAD~1",
          "Moves the branch back one commit and keeps your changes staged.",
        ],
        [
          "undo last commit discard changes throw away",
          "git reset --hard HEAD~1",
          "Deletes the last commit AND its changes. Not recoverable except through git reflog.",
        ],
        [
          "change edit amend last commit message",
          'git commit --amend -m "new message"',
          "Rewrites the last commit; only do it before pushing.",
        ],
        [
          "unstage remove file from staging area",
          "git restore --staged <file>",
          "Keeps the edits, takes the file out of the next commit.",
        ],
        [
          "discard local changes in a file revert file",
          "git restore <file>",
          "Throws away uncommitted edits to that file.",
        ],
        [
          "create new branch and switch",
          "git switch -c <name>",
          "Creates the branch and moves to it.",
        ],
        [
          "delete branch local remove",
          "git branch -d <name>",
          "Safe delete; use -D to force. Remote: git push origin --delete <name>.",
        ],
        ["rename branch", "git branch -m <old> <new>", "Renames a local branch."],
        [
          "stash save work temporarily shelve",
          'git stash push -u -m "wip"  then  git stash pop',
          "Shelves tracked and untracked changes; pop brings them back.",
        ],
        [
          "squash combine last commits into one",
          "git rebase -i HEAD~3",
          "Mark the later commits as squash/fixup in the editor. Rewrites history.",
        ],
        [
          "who changed this line blame",
          "git blame -L 10,20 <file>",
          "Shows the author and commit for lines 10 to 20.",
        ],
        [
          "find which commit introduced a bug bisect",
          "git bisect start; git bisect bad; git bisect good <commit>",
          "Git binary-searches history; mark each step good or bad, then git bisect reset.",
        ],
        [
          "set upstream push new branch first time",
          "git push -u origin <branch>",
          "Pushes and remembers the remote branch.",
        ],
        [
          "committed to wrong branch move commit cherry-pick",
          "git switch <right-branch>; git cherry-pick <sha>; then on the wrong branch: git reset --hard HEAD~1",
          "Copies the commit to the right branch, then removes it from the wrong one.",
        ],
        [
          "sync fork update from upstream",
          "git remote add upstream <url>; git fetch upstream; git merge upstream/main",
          "Brings the original repository's changes into your fork.",
        ],
        [
          "see file at old commit show previous version",
          "git show <sha>:<path>",
          "Prints the file as it was in that commit.",
        ],
        [
          "undo a pushed commit revert safely",
          "git revert <sha>",
          "Adds a new commit that undoes it; safe for shared branches.",
        ],
        [
          "list files changed in commit",
          "git show --stat <sha>",
          "Summary of files touched by a commit.",
        ],
        [
          "remove untracked files clean",
          "git clean -nd  (dry run)  then  git clean -fd",
          "Deletes untracked files and folders. Always dry-run first.",
        ],
        [
          "recover lost commit after reset reflog",
          "git reflog; git reset --hard <sha>",
          "reflog lists where HEAD was; reset back to the lost commit.",
        ],
        [
          "merge conflict resolve abort",
          "git merge --abort  (or edit files, git add, git commit)",
          "Abort returns to before the merge.",
        ],
        [
          "ignore file already tracked gitignore",
          "git rm --cached <file>  then add it to .gitignore",
          "Stops tracking but keeps the file on disk.",
        ],
        [
          "compare branches difference between",
          "git diff main..feature --stat",
          "Shows what the feature branch changes.",
        ],
        [
          "tag release version",
          'git tag -a v1.2.0 -m "release"; git push origin v1.2.0',
          "Creates an annotated tag and shares it.",
        ],
        [
          "clone only latest shallow fast",
          "git clone --depth 1 <url>",
          "Downloads just the latest snapshot.",
        ],
      ];
      const STOP = new Set(
        "the a an to my how do i can you me of in on it is and for with git".split(" "),
      );

      async function run(input = {}) {
        const t = String(input?.prompt ?? input?.text ?? "").toLowerCase();
        const words = new Set(
          (t.match(/[a-z]+/g) ?? []).filter((w) => !STOP.has(w) && w.length > 2),
        );
        if (!words.size)
          return {
            ok: false,
            error: "Describe what you want to do in git, e.g. undo my last commit.",
          };
        const scored = R.map(([keys, cmd, note]) => {
          const kw = keys.split(" ");
          const hits = kw.filter((k) => words.has(k)).length;
          return { hits, cmd, note, keys };
        })
          .filter((r) => r.hits >= 2)
          .sort((a, b) => b.hits - a.hits)
          .slice(0, 3);
        if (!scored.length)
          return {
            ok: false,
            error:
              "No git recipe matches; try words like undo, amend, stash, squash, branch, revert, blame.",
          };
        return {
          ok: true,
          recipes: scored.map(({ cmd, note }) => ({ command: cmd, note })),
          answer: scored.map((r) => `${r.cmd}\n  ${r.note}`).join("\n"),
        };
      }

      return run;
    })(),
  },
  {
    id: "windows-help",
    gate: /windows|win\+|shortcut|hotkey|\.msc|\.cpl|ms-settings|run box|run dialog|settings page|task manager|device manager|control panel|keyboard/,
    run: (() => {
      // Windows reference: keyboard shortcuts, Run-box commands and ms-settings: pages, found by what you want to do.
      const SHORTCUTS = [
        ["Win+D", "show or hide the desktop"],
        ["Win+E", "open File Explorer"],
        ["Win+L", "lock the PC"],
        ["Win+R", "open the Run box"],
        ["Win+I", "open Settings"],
        ["Win+X", "power user menu (Device Manager, Terminal, Disk Management)"],
        ["Win+V", "clipboard history"],
        ["Win+Shift+S", "screenshot tool: snip an area"],
        ["Win+PrtScn", "save a full screenshot to Pictures/Screenshots"],
        ["Win+Tab", "task view and virtual desktops"],
        ["Win+Ctrl+D", "new virtual desktop"],
        ["Win+Ctrl+Left/Right", "switch virtual desktop"],
        ["Win+Left/Right", "snap window to a side"],
        ["Win+Up/Down", "maximise or restore a window"],
        ["Win+.", "emoji and symbols"],
        ["Win+H", "voice typing"],
        ["Win+A", "quick settings"],
        ["Win+N", "notifications and calendar"],
        ["Win+K", "cast to a display"],
        ["Win+P", "project to a second screen"],
        ["Win+M", "minimise all windows"],
        ["Win+,", "peek at the desktop"],
        ["Win+Pause", "System about page"],
        ["Ctrl+Shift+Esc", "Task Manager"],
        ["Ctrl+Alt+Del", "security screen"],
        ["Alt+Tab", "switch between windows"],
        ["Alt+F4", "close the window (shut down on the desktop)"],
        ["F2", "rename the selected file"],
        ["Ctrl+Shift+N", "new folder in File Explorer"],
        ["Alt+Enter", "properties of the selected item"],
        ["Ctrl+Shift+T", "reopen the closed browser tab"],
        ["Ctrl+Z / Ctrl+Y", "undo / redo"],
        ["Ctrl+Shift+V", "paste as plain text (most apps)"],
        ["Win+Ctrl+Shift+B", "restart the graphics driver"],
        ["Shift+Delete", "delete permanently, skipping the Recycle Bin"],
      ];
      const RUN = [
        ["appwiz.cpl", "uninstall or change programs"],
        ["ncpa.cpl", "network adapters"],
        ["devmgmt.msc", "Device Manager"],
        ["diskmgmt.msc", "Disk Management"],
        ["services.msc", "Services"],
        ["eventvwr.msc", "Event Viewer"],
        ["taskschd.msc", "Task Scheduler"],
        ["compmgmt.msc", "Computer Management"],
        ["lusrmgr.msc", "local users and groups"],
        ["gpedit.msc", "Group Policy (Pro editions)"],
        ["certmgr.msc", "certificates"],
        ["perfmon", "Performance Monitor"],
        ["resmon", "Resource Monitor"],
        ["taskmgr", "Task Manager"],
        ["regedit", "Registry Editor (back up first)"],
        ["msconfig", "System Configuration (startup and boot)"],
        ["msinfo32", "System Information"],
        ["dxdiag", "DirectX and graphics information"],
        ["winver", "Windows version"],
        ["sysdm.cpl", "System Properties (environment variables, performance)"],
        ["firewall.cpl", "Windows Firewall"],
        ["powercfg.cpl", "power options"],
        ["main.cpl", "mouse settings"],
        ["timedate.cpl", "date and time"],
        ["inetcpl.cpl", "Internet options"],
        ["control", "Control Panel"],
        ["cleanmgr", "Disk Cleanup"],
        ["mstsc", "Remote Desktop connection"],
        ["cmd", "Command Prompt"],
        ["powershell", "PowerShell"],
        ["wt", "Windows Terminal"],
        ["shell:startup", "your Startup folder"],
        ["shell:appdata", "AppData\\Roaming"],
        ["%localappdata%", "AppData\\Local"],
        ["%temp%", "temporary files folder"],
        ["shell:recyclebinfolder", "Recycle Bin"],
        ["shell:downloads", "Downloads folder"],
        ["snippingtool", "Snipping Tool"],
        ["calc", "Calculator"],
        ["notepad", "Notepad"],
        ["mspaint", "Paint"],
        ["charmap", "Character Map"],
        ["mdsched", "Windows Memory Diagnostic"],
        ["perfmon /rel", "Reliability Monitor"],
      ];
      const SETTINGS = [
        ["ms-settings:network", "network and internet"],
        ["ms-settings:network-wifi", "Wi-Fi"],
        ["ms-settings:bluetooth", "Bluetooth and devices"],
        ["ms-settings:display", "display"],
        ["ms-settings:sound", "sound"],
        ["ms-settings:appsfeatures", "installed apps"],
        ["ms-settings:defaultapps", "default apps"],
        ["ms-settings:startupapps", "startup apps"],
        ["ms-settings:windowsupdate", "Windows Update"],
        ["ms-settings:recovery", "recovery and reset this PC"],
        ["ms-settings:privacy-microphone", "microphone privacy"],
        ["ms-settings:privacy-webcam", "camera privacy"],
        ["ms-settings:privacy-location", "location privacy"],
        ["ms-settings:powersleep", "power and sleep"],
        ["ms-settings:batterysaver", "battery"],
        ["ms-settings:storagesense", "storage"],
        ["ms-settings:about", "about this PC"],
        ["ms-settings:personalization", "personalisation"],
        ["ms-settings:taskbar", "taskbar"],
        ["ms-settings:easeofaccess", "accessibility"],
        ["ms-settings:dateandtime", "date and time"],
        ["ms-settings:regionlanguage", "language and region"],
        ["ms-settings:printers", "printers and scanners"],
        ["ms-settings:nightlight", "night light"],
        ["ms-settings:notifications", "notifications"],
        ["ms-settings:windowsdefender", "Windows Security"],
        ["ms-settings:developers", "developer settings"],
        ["ms-settings:troubleshoot", "troubleshooters"],
        ["ms-settings:network-vpn", "VPN"],
        ["ms-settings:network-proxy", "proxy"],
      ];
      const STOP = new Set(
        "the a an to my how do i can you me of in on it is and for with open show windows what which key keys shortcut command settings page".split(
          " ",
        ),
      );

      function search(table, text, kind) {
        const words = (text.toLowerCase().match(/[a-z0-9+.]+/g) ?? []).filter(
          (w) => !STOP.has(w) && w.length > 1,
        );
        if (!words.length) return [];
        return table
          .map(([key, desc]) => {
            const hay = `${key} ${desc}`.toLowerCase();
            const hits = words.filter((w) => hay.includes(w)).length;
            return { key, desc, hits, kind };
          })
          .filter((r) => r.hits > 0)
          .sort((a, b) => b.hits - a.hits)
          .slice(0, 5);
      }

      async function run(input = {}) {
        const t = String(input?.prompt ?? input?.text ?? "");
        const want = (re) => re.test(t.toLowerCase());
        let results = [];
        if (want(/ms-settings|settings page|open settings|uri|deep link/))
          results = search(SETTINGS, t, "settings");
        else if (want(/shortcut|hotkey|keyboard|key combo|press|win\+|ctrl\+|alt\+/))
          results = search(SHORTCUTS, t, "shortcut");
        else if (
          want(
            /run box|run dialog|\.msc|\.cpl|command to open|win\+r|open .*(manager|console|panel|monitor|editor)/,
          )
        )
          results = search(RUN, t, "run");
        if (!results.length)
          results = [
            ...search(SHORTCUTS, t, "shortcut"),
            ...search(RUN, t, "run"),
            ...search(SETTINGS, t, "settings"),
          ]
            .sort((a, b) => b.hits - a.hits)
            .slice(0, 5);
        if (!results.length)
          return {
            ok: false,
            error:
              "Ask what you want to do, e.g. shortcut for screenshot, command to open Device Manager, or settings page for Wi-Fi.",
          };
        return {
          ok: true,
          results: results.map(({ key, desc, kind }) => ({ kind, key, description: desc })),
          answer: results
            .map(
              (r) =>
                `${r.key}: ${r.desc}${r.kind === "run" ? " (Win+R)" : r.kind === "settings" ? " (Win+R, or start ms-settings:...)" : ""}`,
            )
            .join("\n"),
        };
      }

      return run;
    })(),
  },
];

const PLAIN = new Set(["prompt", "text", "previous"]);

export async function run(input = {}) {
  const wanted = input?.part != null ? String(input.part) : "";
  const prompt = String(input?.prompt ?? input?.text ?? "").toLowerCase();
  const structured = Object.keys(input ?? {}).some((k) => !PLAIN.has(k));
  const chosen = wanted ? PARTS.filter((p) => p.id === wanted) : PARTS;
  if (wanted && !chosen.length) {
    return {
      ok: false,
      error: `Unknown part "${wanted}". Parts: ${PARTS.map((p) => p.id).join(", ")}.`,
    };
  }
  const hits = [];
  const misses = [];
  for (const p of chosen) {
    if (!wanted && p.gate && !structured && !p.gate.test(prompt)) continue;
    let r;
    try {
      r = await p.run(input);
    } catch (error) {
      r = { ok: false, error: String(error?.message ?? error) };
    }
    if (r && r.ok === true) hits.push({ part: p.id, result: r });
    else misses.push({ part: p.id, result: r });
  }
  if (!hits.length) {
    if (wanted) return { ...(misses[0]?.result ?? { ok: false }), ok: false, part: wanted };
    return {
      ok: false,
      error: misses.length
        ? misses.map((m) => `${m.part}: ${m.result?.error ?? "not for this request"}`).join(" | ")
        : `Nothing in this request fits: ${PARTS.map((p) => p.id).join(", ")}.`,
      parts: PARTS.map((p) => p.id),
    };
  }
  const [first, ...rest] = hits;
  const out = { ...first.result, part: first.part };
  if (rest.length) out.also = rest.map((h) => ({ part: h.part, answer: h.result.answer ?? null }));
  return out;
}

export default run;
