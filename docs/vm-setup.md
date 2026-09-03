# VM Setup — Proxmox → Ubuntu → Paper → OpenRouter → Agent01

Start-to-finish guide for reproducing the complete `ai-plays-minecraft` lab
from zero on a new Ubuntu Server VM. Follow it top to bottom; each stage is
verified before the next one begins.

> **Scope.** This guide covers infrastructure only: VM, OS, Java, Node.js,
> Paper, networking, firewall, the application, systemd, backups,
> troubleshooting, and the deployment workflow. It does not redesign the
> application — see [architecture.md](architecture.md) for that.

**Debugging order (read this first).** Verify components in this order and
never debug everything at once:

1. Ubuntu works
2. Network works
3. Java works
4. Paper works
5. Desktop Minecraft can join
6. Node works
7. Repository tests pass
8. OpenRouter works
9. Mineflayer joins
10. Benchmark works
11. Autonomous cognition starts

If something breaks, the faulty layer is almost always the *last* one you
touched.

---

## 0. Version pins

This lab is pinned to these versions. Do not mix and match:

| Component       | Version              |
| --------------- | -------------------- |
| Minecraft Java  | **1.21.11**          |
| Paper           | **1.21.11**          |
| Java            | **OpenJDK 21**       |
| Node.js         | **22 or newer**      |
| Desktop client  | plain vanilla **Release 1.21.11** |

The desktop client must also be 1.21.11 (see section 15). No Forge, Fabric,
OptiFine, or other mod loaders for the initial lab.

---

## 1. Architecture overview

```
Gaming desktop
      │
      │ Minecraft TCP 25565
      ▼
Ubuntu VM on Proxmox
├── Paper 1.21.11
│   └── persistent world
│
└── Agent01
    ├── Mineflayer
    ├── autonomous runtime
    ├── memory
    └── OpenRouter
            │
            ▼
         Internet
```

- **Paper** hosts one persistent world on the VM.
- **Agent01** is a headless bot: [Mineflayer](https://github.com/PrismarineJS/mineflayer)
  connects to Paper using the Minecraft protocol. It does **not** run a
  normal rendered Minecraft client, so the VM stays completely headless —
  no desktop environment, no GPU.
- **Cognition** (goals, plans, skills, reflection) comes from an LLM
  accessed remotely through **OpenRouter**, which is why no GPU is needed.
- The **gaming desktop** connects separately to the same Paper server to
  watch or play alongside the agent. Both the human and Agent01 exist in
  the same world (see section 23).
- A future Twitch POV overlay is out of scope for this setup; the agent
  already emits everything an overlay would need into
  `logs/decisions.jsonl` (see section 28).

---

## 2. Create the Proxmox VM

Create a normal KVM VM in Proxmox with roughly these resources. These are
**starting recommendations, not strict requirements** — Paper is the main
memory consumer, while Mineflayer and the OpenRouter client are relatively
lightweight:

| Setting | Recommendation              |
| ------- | --------------------------- |
| OS      | Ubuntu Server 24.04 (devbox runs 24.04.4 LTS, see §3) |
| CPU     | 4 vCPU cores                |
| RAM     | 8192 MB                     |
| Disk    | 40–60 GB                    |
| Network | VirtIO, bridged to the normal LAN bridge |
| Extras  | QEMU Guest Agent if desired |
| GPU     | None required               |

Notes:

- Bridge the VM to your normal LAN so the gaming desktop can reach
  TCP 25565 directly. The exact Proxmox bridge name (often `vmbr0`, but it
  varies) should **not** be hard-coded anywhere in this project.
- Do not assume any specific Proxmox storage backend — defaults are fine.
- Tailscale is optional but useful if you ever want to reach the lab from
  outside your LAN without exposing anything publicly (see §13).

This repository deliberately does **not** automate Proxmox itself — no
Terraform, no Proxmox API provisioning. Create the VM manually in the
Proxmox UI; infrastructure automation can be a later project.

---

## 3. Install Ubuntu Server

Perform a normal Ubuntu Server installation:

- Create a normal **non-root user** (all commands below assume that user).
- Enable the **SSH server** so you can administer the headless VM.
- **DHCP is fine initially**; consider a static lease/DHCP reservation on
  your router later so the VM's LAN IP doesn't move. (Devbox currently sits
  at `192.168.100.202/24`, gateway `192.168.100.1` — a reservation for the
  same address works equally well.)
- No desktop environment, no extra snaps required.

After first login over SSH:

```bash
sudo apt update
sudo apt upgrade -y
```

Reboot if the upgrade installed a new kernel:

```bash
sudo reboot
```

---

## 4. Install base utilities

```bash
sudo apt install -y \
  curl \
  wget \
  git \
  jq \
  unzip \
  tmux \
  ufw \
  ca-certificates \
  gnupg
```

What they are for: `curl`/`wget` for downloads, `git` for the repository,
`jq` for querying the Paper downloads API (§8), `tmux` for interactive
development sessions (§24), `ufw` for the firewall (§13).

> The repository's `scripts/setup-ubuntu.sh` handles the **Node.js side**
> (NodeSource Node 22 + `npm install`) and now refuses to settle for a
> Node older than v22. It does not install the base utilities above —
> install those with the `apt` command first, then let the script do the
> Node part (§7).

---

## 5. Create the directory layout

The final VM layout is:

```
/home/<user>/
└── minecraft-lab/
    ├── server/              # paper.jar, server.properties, world/, logs/
    │   ├── paper.jar
    │   ├── server.properties
    │   ├── eula.txt
    │   ├── whitelist.json
    │   ├── world/
    │   ├── world_nether/
    │   ├── world_the_end/
    │   ├── logs/
    │   └── other Paper runtime data
    │
    ├── ai-plays-minecraft/  # this Git repository (+ .env, data/, logs/)
    │
    └── backups/             # world archives (see §29)
```

Create it:

```bash
mkdir -p ~/minecraft-lab/server
mkdir -p ~/minecraft-lab/backups
cd ~/minecraft-lab
```

The repository will later be cloned as `~/minecraft-lab/ai-plays-minecraft`
(§16). On devbox there is additionally a legacy `~/minecraft-lab/agent/`
prototype (early Mineflayer `bot.js`, predates this repository) — leave it
alone; it is not part of the lab.

**The Minecraft server and world MUST remain outside the Git
repository** because:

- worlds change constantly (every block edit, every player movement);
- worlds can become large (far beyond what belongs in source control);
- server runtime files (`world/`, `logs/`, caches) are not source code;
- **Git is not a world-backup mechanism** — use timestamped archives
  plus Proxmox snapshots (§29).

---

## 6. Install Java 21

Paper 1.21.11 runs on Java 21 in this setup:

```bash
sudo apt install -y openjdk-21-jre-headless
```

Verify:

```bash
java -version
```

Expected: something like `openjdk version "21.0.x"`. If you see Java 17 or
older as the default, install the package above and re-check.

---

## 7. Install Node.js 22+

The project requires Node.js 22 or newer (`"engines": { "node": ">=22" }`
in `package.json`). Install via NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

Then verify — **Node must be at least v22**:

```bash
node --version   # expect v22.x.x or newer
npm --version
```

Shortcut: from the repository root you can instead run
`bash scripts/setup-ubuntu.sh`, which installs Node 22 (or upgrades an
older Node) and runs `npm install`. It prints the versions when done —
check that `node --version` really shows v22+.

---

## 8. Download Paper 1.21.11

Work in `~/minecraft-lab/server`. The Paper downloads API is queried with
`jq`, pinning Minecraft **1.21.11** and selecting a `STABLE` channel
build. (Compatibility of this exact query was verified against
`fill.papermc.io` while writing this guide: the endpoint returns a JSON
array of builds with `.downloads."server:default".url`, and STABLE builds
for 1.21.11 were present.)

You can do it manually:

```bash
cd ~/minecraft-lab/server

PROJECT="paper"
MC_VERSION="1.21.11"
USER_AGENT="ai-plays-minecraft/1.0 (private-homelab)"

BUILDS="$(curl -fsSL \
  -H "User-Agent: $USER_AGENT" \
  "https://fill.papermc.io/v3/projects/${PROJECT}/versions/${MC_VERSION}/builds")"

PAPER_URL="$(echo "$BUILDS" | jq -r \
  'first(.[] | select(.channel == "STABLE") | .downloads."server:default".url) // empty')"

test -n "$PAPER_URL" || {
  echo "No stable Paper build found"
  exit 1
}

curl -fL \
  -H "User-Agent: $USER_AGENT" \
  "$PAPER_URL" \
  -o paper.jar

ls -lh paper.jar
```

Or use the helper script (same behavior, refuses to overwrite an existing
`paper.jar` unless you pass `--force`, never touches
`server.properties`, never accepts the EULA):

```bash
cd ~/minecraft-lab/ai-plays-minecraft
bash scripts/install-paper.sh
bash scripts/install-paper.sh --help   # all options
```

Notes:

- The `User-Agent` header is required by the Paper service — keep it.
- This pins **Minecraft 1.21.11** but takes the newest STABLE Paper
  *build* for it. That is intentional: never silently download "latest
  Minecraft". See §33 before ever changing the Minecraft version.

---

## 9. First Paper launch and EULA

Launch once to generate the server files:

```bash
cd ~/minecraft-lab/server
java -Xms2G -Xmx4G -jar paper.jar --nogui
```

The first launch is **expected to stop** with a message that you must agree
to the Minecraft EULA. Accept it:

```bash
sed -i 's/eula=false/eula=true/' eula.txt
```

Verify:

```bash
cat eula.txt
```

It should now read `eula=true`.

> Accepting the EULA means you agree to Mojang's Minecraft EULA
> (https://www.minecraft.net/en-us/eula). Only do this for your own
> private lab.

---

## 10. Configure server.properties

Edit the generated file:

```bash
nano ~/minecraft-lab/server/server.properties
```

Set these values for the private lab:

```properties
server-port=25565
online-mode=false
white-list=true
max-players=5
motd=AI Agent Lab
difficulty=easy
gamemode=survival
view-distance=10
simulation-distance=8
spawn-protection=0
enforce-secure-profile=false
```

What the security-sensitive ones mean:

- **`online-mode=false`** — Paper does *not* authenticate usernames with
  Mojang/Microsoft. This is required here because Agent01 connects with
  Mineflayer offline authentication (`auth: 'offline'` in
  `src/bot/createBot.js`) and the gaming desktop currently uses
  TLauncher/offline-style authentication. Usernames are **not verified**,
  so anyone who can reach the port can join as anyone.
- **`enforce-secure-profile=false`** — offline-mode clients do not present
  Mojang-signed chat profiles; without this they get kicked with secure
  profile/chat errors.
- **`white-list=true`** — only explicitly whitelisted names may join (§12).
  This is your real access control given offline mode.
- **`spawn-protection=0`** — lets the bot (a non-op player) break/place
  blocks near spawn instead of being blocked by spawn protection.
- `view-distance=10` / `simulation-distance=8` — modest chunk load keeps
  RAM usage reasonable for a 4–8 GB VM.

> ⚠️ **WARNING — keep this server private.** Because `online-mode=false`,
> **DO NOT expose TCP 25565 directly to the public Internet** (no router
> port forwarding). Reach the server only via private LAN, Tailscale,
> and the whitelist (§13).

Restart Paper after any `server.properties` change — Paper only reads the
file at startup.

---

## 11. Start Paper

```bash
cd ~/minecraft-lab/server
java -Xms2G -Xmx4G -jar paper.jar --nogui
```

Successful startup roughly looks like: Paper prints its version and
server-information lines, prepares spawn chunks (`Preparing spawn area`),
`Running delayed init tasks`, and finally `Done (X.XXXs)! For help, type
"help"`. You get an interactive `>` console prompt. Type `help` and
`version` to confirm the console responds and reports 1.21.11.

Keep this console open for the next steps (§12); production startup via
systemd comes later (§25).

---

## 12. Configure the whitelist

Because `white-list=true`, every account must be whitelisted in the Paper
console (the terminal where Paper is running, lines starting with `>`):

```
whitelist add Agent01
```

`Agent01` is the Mineflayer account (`MC_USERNAME` in `.env`, §17).

Then whitelist yourself. The current TLauncher username on the gaming
desktop is `younes`, so the example is:

```
whitelist add younes
```

…but **use the EXACT username configured in your Minecraft/TLauncher
client** — whatever name you actually log in with. If a future user has a
different name, whitelist *that* name instead. Do not assume everyone is
named `younes`.

Verify:

```
whitelist list
```

Both names should appear. On devbox the whitelist currently contains exactly
`Agent01` and `younes` (offline-mode UUIDs), and `ops.json` is empty — nobody,
bot included, is an operator. If the desktop later gets "You are not
whitelisted", the TLauncher profile name and the whitelist entry differ —
re-check spelling and case.

---

## 13. Configure the firewall

Goal: the LAN (and optionally Tailscale) can reach TCP 25565; the public
Internet cannot. This lab's actual network is `192.168.100.0/24`
(devbox = `192.168.100.202`, gateway `192.168.100.1`) — **replace it with
your actual LAN subnet** if yours differs.

⚠️ **Do NOT enable UFW before allowing SSH**, or you will lock yourself
out. Safe sequence — scoped to the LAN (this is exactly what devbox
enforces):

```bash
sudo ufw allow from 192.168.100.0/24 to any port 22 proto tcp
```

(If your SSH port differs, adjust the port; `sudo ufw allow OpenSSH` is
the less strict equivalent when you have no LAN to scope to yet).

Then the Minecraft rule (LAN only):

```bash
sudo ufw allow from 192.168.100.0/24 to any port 25565 proto tcp
```

If UFW is not already enabled:

```bash
sudo ufw enable
```

Then check:

```bash
sudo ufw status verbose
```

You should see the SSH rule plus the 25565 rule limited to your subnet —
**not** `25565/tcp ALLOW IN Anywhere`. For reference, devbox reports
(default-deny incoming):

```
22/tcp    ALLOW IN    192.168.100.0/24
25565/tcp ALLOW IN    192.168.100.0/24
```

Tailscale alternative (not installed on devbox — LAN-only for now):

```bash
sudo ufw allow in on tailscale0 to any port 25565 proto tcp
```

LAN and Tailscale rules can coexist — add both if you use both.

Again: **no public router port-forward** for this lab. With
`online-mode=false`, a publicly reachable port means anyone can join as
anyone, including as `Agent01` or as an operator name.

---

## 14. Verify Paper networking

On the VM:

```bash
ss -ltnp | grep 25565
```

Expect a LISTEN line on `0.0.0.0:25565` (all interfaces). Find the VM's
addresses:

```bash
hostname -I
```

Understand the three addresses:

| Address      | Who uses it                          |
| ------------ | ------------------------------------ |
| `127.0.0.1`  | Agent01 on the VM itself (§17)       |
| LAN IP       | Gaming desktop on the same LAN       |
| Tailscale IP | Gaming desktop via Tailscale (if used) |

So: Agent01 connects to `127.0.0.1:25565`, while the gaming desktop
connects to `VM_LAN_IP:25565` (or `VM_TAILSCALE_IP:25565`).

---

## 15. Join from the gaming desktop

The current client is **TLauncher** on the gaming desktop. Steps:

1. Open TLauncher.
2. In the version list, select the plain vanilla **Release 1.21.11**
   (just the release — no Forge, Fabric, OptiFine, or other mod loaders).
3. Launch Minecraft.
4. Open **Multiplayer** → **Add Server**.
5. Enter the VM's LAN IP (or Tailscale IP), port 25565 —
   e.g. `192.168.100.10:25565`.
6. Join.

If Paper rejects the connection with "You are not whitelisted", your
TLauncher profile username does not exactly match the whitelist entry —
fix the whitelist (§12), not the network. If it fails with a version
error, the client is not on plain 1.21.11.

**Stop here until joining works.** Proving Paper works *before* involving
the AI agent makes every later debugging step easier (debugging order,
§0).

---

## 16. Clone ai-plays-minecraft

Only once Paper works independently:

```bash
cd ~/minecraft-lab
git clone YOUR_REPOSITORY_URL ai-plays-minecraft
cd ai-plays-minecraft
npm install
```

(`YOUR_REPOSITORY_URL` is the Git URL of this project.)

Prefer `npm ci` on the VM when `package-lock.json` is present and you want
a clean reproducible install (§32). If you cloned fresh and just want to
run, `npm install` is fine; the guide's deployment path (§32) uses
`npm ci`.

---

## 17. Configure the application

```bash
cp .env.example .env
nano .env
```

Every variable below exists in the repo's actual `.env.example`
(and `src/safety/limits.js` clamps the numeric ones). Important values:

```ini
MC_HOST=127.0.0.1
MC_PORT=25565
MC_USERNAME=Agent01
MC_VERSION=1.21.11

AGENT_MODE=autonomous
```

- `MC_HOST=127.0.0.1` — the agent runs on the same VM as Paper (§14).
- `MC_USERNAME=Agent01` — must match the whitelisted bot name (§12).
- `MC_VERSION=1.21.11` — must match the Paper server *and* the desktop
  client; Mineflayer protocol support for 1.21.11 was verified with the
  bundled `minecraft-data`.
- `AGENT_MODE=autonomous` — the main mode: the agent chooses its own
  goals, plans with trusted primitives and reusable declarative skills,
  and learns via reflection + JSON memory (see §22).
- `AGENT_MODE=benchmark` — the preserved deterministic regression test:
  **collect 8 logs without dying**, bounded (defaults to 30 steps when
  `MAX_AGENT_STEPS=0`), using the legacy allowlist
  (`observe`, `collect_logs`, `chat`, `wait`, `finish` in
  `src/safety/validator.js`). Used in §21.
- `AGENT_DIRECTIVE` — the long-term autonomous directive (default:
  survive, explore, gather resources, improve equipment, build shelter,
  learn, progress without dying). Only read in autonomous mode.
- `AGENT_GOAL` — the benchmark goal text (default:
  `Collect 8 logs without dying.`). Only read in benchmark mode.
- `MAX_AGENT_STEPS=0` — loop bound; `0` = run forever in autonomous mode
  (benchmark substitutes its own 30-step default when `0`).
- The remaining keys (`DECISION_DELAY_MS`, `OBSERVATION_RADIUS`,
  `MAX_*`, `REFLECTION_ENABLED`, `MEMORY_ENABLED`,
  `SKILL_GENERATION_ENABLED`, timeouts, backoff, combat bounds) tune
  perception size, memory bounds, and safety caps. Defaults are sane for
  the lab; see the Configuration table in `README.md` and change them
  only deliberately.

Do not invent configuration names — if a key is not in `.env.example`,
the code does not read it. Inline variables take precedence over `.env`:
`scripts/start-agent.sh` and `scripts/test-openrouter.sh` only fill in
variables not already set, so `AGENT_MODE=benchmark npm start` works even
when `.env` says `AGENT_MODE=autonomous`.

---

## 18. Configure OpenRouter

1. Create an account at https://openrouter.ai.
2. Create a **project-specific API key** (a dedicated key just for this
   lab, so you can revoke it without affecting anything else).
3. Put it **only** inside `.env` on the VM — never commit `.env`
   (`.gitignore` already excludes it; verify with
   `git check-ignore -v .env`).
4. Set the model variables in `.env`:

```ini
OPENROUTER_API_KEY=...your key here...
OPENROUTER_MODEL=openrouter/free
OPENROUTER_APP_NAME="AI Plays Minecraft"
```

- `OPENROUTER_MODEL=openrouter/free` routes requests only to free models
  and is the default for initial testing. Free routes can still be rate
  limited — watch your OpenRouter dashboard.
- Later, pin an exact model ID (copied verbatim from the OpenRouter model
  list) for predictable cost, latency, and reproducible agent behavior.
- This repo hard-codes no paid model: the default lives in `.env.example`
  and `src/llm/openrouter.js` falls back to `openrouter/free` when the
  variable is empty.

---

## 19. Test OpenRouter before running the Minecraft agent

The repo has a dedicated smoke test that calls OpenRouter **without**
starting the bot:

```bash
npm run test:openrouter
```

It sends a trivial prompt (`Reply with the single word: ok`) using your
`.env` key/model and prints the raw response. Success means your key,
model ID, and Internet route all work.

Do this separately on purpose: Paper problems and OpenRouter problems
must not be debugged simultaneously (debugging order, §0).

---

## 20. Run repository tests

```bash
npm test
```

This runs the unit suite with the Node built-in test runner. Unit tests
require **no** Minecraft server, **no** OpenRouter key, and **no**
Internet.

Optional but recommended — syntax check all sources:

```bash
npm run check
```

---

## 21. First benchmark run

Before unleashing autonomous mode, run the preserved benchmark to prove
the full chain works end to end:

```
Paper → Mineflayer → perception → planning → action execution
```

with a bounded, checkable task (**collect 8 logs without dying**):

```bash
AGENT_MODE=benchmark npm start
```

(or set `AGENT_MODE=benchmark` in `.env` and run `npm start` /
`bash scripts/start-agent.sh`).

Watch the logs: you should see `Benchmark loop started`, per-step
`action=…` lines, and eventually `Goal complete … logs` (or
`Step budget exhausted` if the spawn area has no trees in range — in that
case check the world and §34). The bot quits automatically when the
benchmark ends.

---

## 22. Autonomous mode

Once the benchmark passes, enable the real mode:

```bash
AGENT_MODE=autonomous npm start
```

(or `AGENT_MODE=autonomous` in `.env`, which is the shipped default).

Design intent: the agent should **survive, create its own goals, plan,
use declarative skills, remember experiences, learn strategies, react to
danger, and progress through Minecraft** — implemented today as the
perception → interrupts → memory-retrieval → cognition → planning →
validated-skill/primitive → outcome → reflection loop documented in
`docs/architecture.md` and `README.md` (goal manager, 20+ trusted
primitives, JSON skill library with scoring, semantic/episodic/procedural/
world memory stores, deterministic interrupts with emergency replanning,
planner circuit breaker with backoff and a no-LLM safe fallback).

Be honest about the boundary between **implemented** and **planned**:

- Implemented: everything in §17's variable list, the autonomous loop,
  benchmark mode, memory persistence, skill learning/scoring, reflection,
  interrupts, telemetry to `logs/decisions.jsonl`.
- Planned / not implemented: Twitch POV streaming and overlay (telemetry
  already exposes what an overlay needs, but no streaming exists yet —
  see `README.md`).

---

## 23. Watching Agent01

Join from the gaming desktop (§15) **while Agent01 is running**. The
server then looks like this:

```
Minecraft server
├── Agent01   (bot)
└── you       (human player)
```

Both exist in the same persistent world. You can watch without
interfering, or — if you deliberately grant yourself permissions — switch
your own client to spectator mode to observe hands-free.

Do **not** make Agent01 an operator: the bot needs no Paper permissions
(it acts through the game protocol like any player), and op status would
only widen the blast radius of weird agent behavior.

---

## 24. Development runtime with tmux

Before promoting anything to systemd, run Paper and the agent in `tmux`
while you are actively debugging — processes are easy to stop, restart,
and inspect:

```bash
tmux new -s minecraft
```

Suggested windows:

- `0: Paper` — `cd ~/minecraft-lab/server && java -Xms2G -Xmx4G -jar paper.jar --nogui`
- `1: Agent` — `cd ~/minecraft-lab/ai-plays-minecraft && npm start`
- `2: shell/logs` — `tail -f logs/decisions.jsonl`, `git status`, etc.

Useful tmux commands:

- Detach (leave everything running): `Ctrl+B` then `D`
- Reattach: `tmux attach -t minecraft`
- List windows: `Ctrl+B` then `w`; new window: `Ctrl+B` then `c`;
  next/previous: `Ctrl+B` then `n` / `p`

Only move to systemd (§25–§27) once the agent survives interactively. On
devbox this is still the current setup: Paper runs in a tmux session named
`minecraft`; neither systemd unit is installed yet (Appendix C).

---

## 25. Paper systemd service

The repo ships a template at `config/systemd/minecraft-paper.service`:

```ini
[Unit]
Description=Minecraft Paper AI Lab Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=YOUR_LINUX_USER
WorkingDirectory=/home/YOUR_LINUX_USER/minecraft-lab/server
ExecStart=/usr/bin/java -Xms2G -Xmx4G -jar paper.jar --nogui
Restart=on-failure
RestartSec=5
TimeoutStopSec=60

[Install]
WantedBy=multi-user.target
```

Install it (replace `YOUR_LINUX_USER` with your actual VM username —
never hard-code someone else's name):

```bash
which java   # must match the ExecStart path; adjust if different
cp ~/minecraft-lab/ai-plays-minecraft/config/systemd/minecraft-paper.service /tmp/minecraft-paper.service
sed -i "s/YOUR_LINUX_USER/$USER/g" /tmp/minecraft-paper.service
sudo cp /tmp/minecraft-paper.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now minecraft-paper
```

Verify:

```bash
sudo systemctl status minecraft-paper
journalctl -u minecraft-paper -f   # live Paper log
```

Paper needs up to a minute to listen on 25565 after (re)start — wait for
the `Done …!` line in the journal before concluding anything is broken.

---

## 26. Agent systemd service

The repo ships `config/systemd/minecraft-agent.service`:

```ini
[Unit]
Description=AI Plays Minecraft Agent
After=network-online.target minecraft-paper.service
Requires=minecraft-paper.service
Wants=network-online.target

[Service]
Type=simple
User=YOUR_LINUX_USER
WorkingDirectory=/home/YOUR_LINUX_USER/minecraft-lab/ai-plays-minecraft
EnvironmentFile=/home/YOUR_LINUX_USER/minecraft-lab/ai-plays-minecraft/.env
ExecStart=/usr/bin/node /home/YOUR_LINUX_USER/minecraft-lab/ai-plays-minecraft/src/index.js
Restart=on-failure
RestartSec=10
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

Notes:

- The entry point is `src/index.js` (the package `main`), matching the
  template. `EnvironmentFile=` loads your `.env` so no shell wrapper is
  needed under systemd; interactive runs still go through
  `bash scripts/start-agent.sh` (`npm start`).
- Verify the Node path first — depending on installation method it may
  not be `/usr/bin/node`:

```bash
which node   # adjust ExecStart if different
```

Install (same placeholder replacement as §25). **Do NOT enable the
autonomous agent at boot until it has been tested interactively** (§21,
§22, §24):

```bash
cp ~/minecraft-lab/ai-plays-minecraft/config/systemd/minecraft-agent.service /tmp/minecraft-agent.service
sed -i "s/YOUR_LINUX_USER/$USER/g" /tmp/minecraft-agent.service
sudo cp /tmp/minecraft-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable minecraft-agent
sudo systemctl start minecraft-agent
```

Verify:

```bash
sudo systemctl status minecraft-agent
journalctl -u minecraft-agent -f
```

---

## 27. Service startup order

Boot order is:

```
network
  ↓
Paper (minecraft-paper.service)
  ↓
Agent01 (minecraft-agent.service, After= + Requires= paper)
```

`Requires=minecraft-paper.service` means stopping Paper also stops the
agent — which is what you want (a bot with no server is useless).

One honest limitation: "Paper started" under systemd does **not** mean
Minecraft is already listening — world loading takes time, and **this
application does not auto-reconnect**: if the bot starts (or the
connection drops) before Paper listens, the process logs `Bot error` /
`Connection ended` and idles instead of retrying, and
`Restart=on-failure` does not fire (the process hasn't crashed). So after
any Paper restart, always restart the agent too:

```bash
sudo systemctl restart minecraft-agent
journalctl -u minecraft-agent -f
```

Inside the agent itself, planning failures are handled (circuit breaker +
backoff + no-LLM safe fallback, §22), but a severed Minecraft connection
is an operator task, not something the code recovers from today.

---

## 28. Runtime data

All state the agent writes, based on the actual implementation:

| Path | What | Survives restart? |
| ---- | ---- | ----------------- |
| `data/semantic.json` | General facts (mob behavior, tool tiers…) | Yes |
| `data/episodic.json` | Important experiences + lessons | Yes |
| `data/procedural.json` | Per-skill success/failure records | Yes |
| `data/world.json` | Named locations (shelter, mine, veins…) | Yes |
| `data/skills.json` | Learned declarative skill library | Yes |
| `logs/decisions.jsonl` | Decision/event stream (`goal_changed`, `plan`, `step`, `reflection`, `interrupt`, `death`, …) | Yes (append-only) |

- Override locations with `MEMORY_DIR` (memory/skills) and `LOG_DIR`
  (decisions log) — used by tests for isolation.
- Corrupt JSON files are backed up as `*.corrupt.*.bak` and treated as
  empty rather than crashing the agent.
- Secrets are redacted in telemetry (`src/telemetry/decisions.js`
  sanitizes keys/tokens), but the live secret still lives only in `.env`.
- **Git-ignored:** `.env`, `logs/`, and all `data/*.json` runtime state
  (see `.gitignore`). Agent memory normally **persists across
  application restarts** — that is how it learns. Delete a store file
  only if you deliberately want the agent to forget (with the service
  stopped).

---

## 29. Backups

A **Proxmox snapshot is NOT a substitute for a proper world backup**:
snapshots capture disk state crash-consistently and live on the same
host. Do both — snapshot *and* timestamped world archives, and copy
archives off the Proxmox host (your laptop, NAS, USB) regularly.

Clean-backup procedure (Paper must be stopped so world files are
consistent):

```bash
sudo systemctl stop minecraft-agent
sudo systemctl stop minecraft-paper
cd ~/minecraft-lab
mkdir -p backups
tar -czf "backups/world-$(date +%F-%H%M).tar.gz" \
  server/world \
  server/world_nether \
  server/world_the_end \
  server/server.properties \
  server/whitelist.json
sudo systemctl start minecraft-paper
# wait for "Done" in journalctl -u minecraft-paper -f, then:
sudo systemctl start minecraft-agent
```

Or use the helper script (same archive layout; it warns — but does not
act — if the services are still running, and fails if world directories
are missing):

```bash
sudo systemctl stop minecraft-agent minecraft-paper
bash ~/minecraft-lab/ai-plays-minecraft/scripts/backup-world.sh
sudo systemctl start minecraft-paper
# …wait for Done, then:
sudo systemctl start minecraft-agent
```

If your Paper installation lays out dimensions differently (extra world
folders), adjust the paths accordingly. Verify archives with
`tar -tzf backups/<file> | head` after creation.

---

## 30. Accessing the world later

Two options:

- **Preferred: leave the world on the VM.** The world is authoritative
  there; just reconnect from the desktop (§15) whenever you want to play
  or watch. Nothing to copy, nothing to desync.
- **Alternative: copy it.** Stop Paper cleanly first
  (`sudo systemctl stop minecraft-paper`), then copy `server/world*`
  (plus `server.properties`/`whitelist.json` if you want the same rules)
  elsewhere — e.g. `scp -r` to your desktop.

Never copy, edit, or `rsync` a **live** world: files change mid-copy and
you get a corrupt or rolled-back dimension. Stop Paper, then copy.

---

## 31. Git deployment workflow

Normal development — laptop edits, VM runs:

**Laptop:**

```
edit code → npm test → npm run check → commit → push
```

**VM:**

```bash
cd ~/minecraft-lab/ai-plays-minecraft
git pull
npm install        # or npm ci if dependencies changed (§32)
npm test
sudo systemctl restart minecraft-agent
journalctl -u minecraft-agent -f
```

- Do **not** restart Paper for normal application-code changes — the
  world keeps running; only the agent restarts.
- Restart Paper only for `server.properties`/JAR changes (§10, §33).

---

## 32. Updating Node dependencies

- `npm install` — resolves and may update `package-lock.json`. Use on
  the laptop during development.
- `npm ci` — clean, reproducible install from `package-lock.json`
  (wipes `node_modules` first, fails if lock and manifest disagree).
  **Prefer `npm ci` on the VM** whenever the lockfile is present:

```bash
cd ~/minecraft-lab/ai-plays-minecraft
npm ci
npm test
sudo systemctl restart minecraft-agent
```

---

## 33. Updating Paper

> ⚠️ **Do NOT casually upgrade Paper/Minecraft independently of
> Mineflayer compatibility.** The lab is pinned to **1.21.11** (§0).

Update procedure:

1. Take a full world backup (§29).
2. Verify the Mineflayer/minecraft-data versions in `package.json`
   support the target Minecraft version (check the Mineflayer release
   notes; locally you can test protocol support with
   `node -e "console.log(!!require('minecraft-data')('<ver>').version)"`).
3. Download the new Paper build (§8 / `scripts/install-paper.sh
   --mc-version <ver>`).
4. Update `MC_VERSION` in `.env` (and `.env.example` if the repo moves).
5. Run the benchmark (§21) to prove the Mineflayer integration still works.
6. Only then run autonomous mode (§22).

**Never downgrade a world without a backup** — newer chunk formats
generally do not open cleanly on older servers.

---

## 34. Troubleshooting

### Paper does not start

- `java -version` — must be OpenJDK 21 (§6).
- `journalctl -u minecraft-paper -f` (systemd) or the console output
  (tmux) for the actual error.
- `cat ~/minecraft-lab/server/eula.txt` — must read `eula=true` (§9).
- RAM: `-Xms2G -Xmx4G` needs ~4 GB free; on a smaller VM lower `-Xmx`
  (e.g. `-Xmx2G`) and reduce `view-distance`.
- Port already in use (`Address already in use`): another Paper is
  running — `ss -ltnp | grep 25565` to find it.

### Desktop cannot connect

- `ss -ltnp | grep 25565` on the VM — is Paper listening?
- `hostname -I` — are you using the right VM IP?
- `sudo ufw status verbose` — is your subnet/Tailscale allowed (§13)?
- Client on plain vanilla Release **1.21.11** (§15)?

### "You are not whitelisted"

- In the Paper console: `whitelist list`.
- The TLauncher profile username must match the entry **exactly**
  (spelling and case). Re-run `whitelist add <exact-name>` (§12).

### "Failed to verify username" / "Invalid session"

- `server.properties` must contain `online-mode=false` (§10).
- **Restart Paper** after editing `server.properties` — it is only read
  at startup.

### Secure profile / chat-signing errors

- `server.properties` must contain `enforce-secure-profile=false` (§10),
  then restart Paper.

### Mineflayer cannot connect

Check, in order:

- `MC_HOST` / `MC_PORT` / `MC_VERSION` / `MC_USERNAME` in `.env` (§17):
  `127.0.0.1`, `25565`, `1.21.11`, `Agent01`.
- Paper actually listening: `ss -ltnp | grep 25565`.
- Bot whitelisted: `whitelist list` in the Paper console.
- Agent logs: `journalctl -u minecraft-agent -f` (or the tmux window).

### Version mismatch

All three must agree:

- Paper: 1.21.11 (§8)
- `MC_VERSION`: 1.21.11 (§17)
- Desktop Minecraft: plain Release 1.21.11 (§15)

### Node errors

- `node --version` — must be **>= 22** (§7). Old Nodes fail with syntax
  or engine errors; re-run `scripts/setup-ubuntu.sh`.
- `npm ci` then `npm test` to rule out a broken `node_modules`.

### OpenRouter 401

Invalid or missing API key: `OPENROUTER_API_KEY` unset/empty in `.env`,
or the key was revoked. Re-create it (§18) and re-run
`npm run test:openrouter` (§19).

### OpenRouter 402

Payment/credits/model-availability: out of credits, or the pinned model
is not available on your account/route. Check the OpenRouter dashboard,
add credits, or try another model ID.

### OpenRouter 429

Rate limit: slow down (raise `DECISION_DELAY_MS`), wait, retry. Sustained
429s mean the model/route is throttled for your key.

### "Invalid model" / model not found

The `OPENROUTER_MODEL` ID must match OpenRouter's catalog **exactly**
(including the `provider/` prefix). Copy it verbatim; `openrouter/free`
is the default for free testing.

### Agent keeps reconnecting or crashing

- `journalctl -u minecraft-agent -f` — top of the traceback tells you
  which layer failed.
- `tail -f ~/minecraft-lab/ai-plays-minecraft/logs/decisions.jsonl` —
  last `plan`/`step`/`planner_failed` entries before the crash.
- OpenRouter errors (401/402/429 above) surface here as
  `planner_failed` with backoff — that is the circuit breaker working,
  not a bug.
- Paper logs: did the server kick the bot (`whitelist`, version) or
  restart (→ restart the agent, §27)?

### Agent pathfinding failures

Not every terrain has a viable path — `move_near` failing on cliffs,
lakes, or caves is normal. Check telemetry (`step` entries with
pathfinding errors) and let the planner replan; persistent failures in
one area usually mean the goal needs a different route, not a code fix.

### Agent behaves badly (but infrastructure is fine)

That is cognition, not infrastructure. Inspect, in order:

1. current **goal** (`goal_changed` entries),
2. most recent **decision** (`plan` entry: assessment + nextStep),
3. retrieved **memories**,
4. chosen **skill** and its score,
5. **primitive result** (`step` entry),
6. **reflection** output.

Do not debug cognition as if it were a networking problem — if the bot is
connected, perceiving, and acting, the VM guide has done its job; tune
goals, memories, and skills instead.

---

## 35. Verification checklist

- [ ] Ubuntu updated (§3)
- [ ] Java 21 installed (`java -version`, §6)
- [ ] Node >= 22 installed (`node --version`, §7)
- [ ] Paper 1.21.11 downloaded (`ls -lh paper.jar`, §8)
- [ ] EULA accepted (`cat eula.txt`, §9)
- [ ] Paper starts (`Done …!`, §11)
- [ ] `online-mode=false` (§10)
- [ ] `enforce-secure-profile=false` (§10)
- [ ] Whitelist enabled (§10)
- [ ] `Agent01` whitelisted (§12)
- [ ] Desktop username whitelisted (§12)
- [ ] TCP 25565 limited to LAN/Tailscale (`ufw status verbose`, §13)
- [ ] Desktop can join on 1.21.11 vanilla (§15)
- [ ] Repo cloned to `~/minecraft-lab/ai-plays-minecraft` (§16)
- [ ] `npm ci` succeeds (§32)
- [ ] `.env` created (key + model + MC_* + AGENT_MODE, §17–§18)
- [ ] OpenRouter test succeeds (§19)
- [ ] `npm test` succeeds (§20)
- [ ] Benchmark succeeds (§21)
- [ ] Autonomous mode starts (§22)
- [ ] Paper systemd works (§25)
- [ ] Agent systemd works (§26)
- [ ] Backups tested (create + list + copy off-host, §29)

---

## Appendix A. Security boundaries

Three boundaries, three different jobs:

### 1. Minecraft server boundary

Because `online-mode=false`, usernames are **unverified**. Security here
is entirely: private LAN/Tailscale + firewall (§13) + whitelist (§12).
Never expose the port publicly; never rely on usernames for identity.

### 2. Agent host boundary

The autonomous LLM is deliberately sandboxed. It receives **only**
bounded JSON perception and returns **only** validated goals/plans/
skills/memories. It does **not** receive: shell access, filesystem
access, environment variables, arbitrary Mineflayer API calls, or the
Paper console. Every model-controlled invocation passes
`validatePrimitiveCall` / `validateSkill` / `validatePlannerOutput` /
`validateReflection`, and the only network call in the codebase is
`fetch()` to OpenRouter (`src/llm/openrouter.js`).

### 3. Secret boundary

The OpenRouter key lives in `.env` **only**. It is never logged
(telemetry redacts secrets), never committed (`.gitignore` excludes
`.env`), and never sent anywhere except OpenRouter. Verify with
`git check-ignore -v .env` and `git status --short` before every commit —
no key, no world files.

## Appendix B. Fresh-VM deployment path (short version)

```bash
# 1. Provision Ubuntu VM (§2–§3), SSH in, update
# 2. Base tools (§4) + layout (§5)
# 3. Java 21 (§6), Node 22+ (§7)
# 4. Paper 1.21.11 (§8), EULA (§9), server.properties (§10)
# 5. Start Paper (§11), whitelist bot + player (§12)
# 6. Firewall, SSH first then 25565 (§13)
# 7. Verify listening + IPs (§14), join from desktop (§15)
# 8. Clone repo, npm ci (§16, §32)
# 9. cp .env.example .env, edit (§17–§18)
npm run test:openrouter   # §19
npm test                  # §20
AGENT_MODE=benchmark npm start   # §21
AGENT_MODE=autonomous npm start  # §22
# 10. systemd services (§25–§26), backups (§29)
```

Helper scripts: `scripts/install-paper.sh` (pinned Paper download),
`scripts/backup-world.sh` (timestamped world archives),
`scripts/setup-ubuntu.sh` (Node 22 + `npm install`),
`scripts/test-openrouter.sh` (via `npm run test:openrouter`),
`scripts/start-agent.sh` (via `npm start`).

---

## Appendix C. As-built record — devbox (2026-09-03)

Concrete state of the lab this guide was verified against. If your VM
differs here, that is the first place to look.

| Item | Actual value |
| ---- | ------------ |
| Hostname / user | `ubuntu` / `agent` |
| LAN | `eth0` = `192.168.100.202/24`, gateway `192.168.100.1` |
| Proxmox resources | 4 vCPU, 7.7 GiB RAM, 48 GB disk (`/dev/sda1`, 12% used) |
| OS | Ubuntu 24.04.4 LTS, kernel 6.8.0-138-generic |
| Java | OpenJDK 21.0.12 (`/usr/bin/java`) |
| Node.js | v22.23.2 (`/usr/bin/node`) |
| Paper | 1.21.11 build 132 (`paper.jar` ≈ 53 MB) |
| Paper command | `java -Xms2G -Xmx4G -jar paper.jar --nogui`, tmux session `minecraft` |
| World sizes | `world` 17M, `world_nether` 2.2M, `world_the_end` 2.2M |
| server.properties (relevant) | `online-mode=false`, `white-list=true`, `enforce-secure-profile=false`, `motd=AI Agent Lab`, `difficulty=easy`, `gamemode=survival`, `max-players=5`, `view-distance=10`, `simulation-distance=8`, `spawn-protection=0`, `server-port=25565`, `level-name=world` |
| Whitelist | `Agent01`, `younes` (offline-mode UUIDs) |
| Operators | none (`ops.json` is `[]`) |
| UFW | active, default deny incoming; `22/tcp` + `25565/tcp` ALLOW IN from `192.168.100.0/24` only |
| Tailscale | not installed (LAN-only) |
| systemd | neither unit installed — Paper runs in tmux (§24) |
| Agent `.env` | stock `.env.example` defaults with `OPENROUTER_MODEL=openrouter/free`, `AGENT_MODE=autonomous` |
| Legacy | `~/minecraft-lab/agent/` — early Mineflayer prototype (`bot.js`), predates the repo; leave alone |
| Misc | `docker0` interface exists but is DOWN (Docker unused by the lab) |

Changes made while verifying this guide: `enforce-secure-profile` was
`true` → set to `false` (§10); inline env overrides (e.g.
`AGENT_MODE=benchmark`) fixed in `scripts/start-agent.sh` (§21); model
default moved to `openrouter/free` (§18).
