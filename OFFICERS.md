# Zeus Clan — Officer Roles & Responsibilities

> Source of truth for officer duties, reporting lines, and cross-functional workflows.
> Mermaid diagrams render automatically on GitHub.

---

## Org Chart

```mermaid
flowchart TD
    Leader["👑 Clan Leader<br/>(You)"]

    subgraph T1[" Tier 1 — Senior Officers "]
        Menelaus["Menelaus<br/>Clan Relations<br/>+ Bot Owner"]
        Pandapple["Pandapple<br/>War Captain<br/>+ External Comms"]
        Pau["Paunginoon<br/>War Captain<br/>+ Attendance"]
        ATL["ATL<br/>External Comms<br/>(Alliance / bzap)"]
    end

    subgraph T2[" Tier 2 — Kion Officers "]
        Monday["Monday<br/>Tower War Lead"]
        Nowhere["NowhereMan<br/>Internal Health"]
        Yna["Ynaguinid<br/>External Events<br/>+ Immortal Liaison"]
    end

    subgraph T3[" Tier 3 — Community & Recruitment "]
        Mana["Manawari<br/>Discord Ops<br/>+ Bot Monitoring"]
        xIcy["xIcy<br/>Recruitment<br/>+ In-Game Reminders"]
        Nali["Nalimotko<br/>Event Prizes"]
        Nutri["Nutristar<br/>In-Game Behavior<br/>+ Prize Backup"]
    end

    Leader --> Menelaus
    Leader --> Pandapple
    Leader --> Pau
    Leader --> ATL

    Menelaus --> Monday
    Menelaus --> Nowhere
    Menelaus --> Yna

    Pandapple --> Mana
    Pandapple --> xIcy
    Pau --> Nali
    Pau --> Nutri
```

---

## Tier 1 — Senior Officers

### 👑 Clan Leader (You)
- [ ] Final call on Shadow War / VoB lineup
- [ ] Receives lineup from Menelaus → forwards to xIcy for in-game reminders
- [ ] Bot owner of record (delegates day-to-day to Menelaus)
- [ ] Receives bug reports from Manawari

### Menelaus — Clan Relations + Bot Owner
- [ ] Maintain alliance contact + internal affairs
- [ ] Draft Shadow War / VoB lineup → submit to Clan Leader
- [ ] **Bot ownership:** zeus-bot admin, role/channel structure, deploys
- [ ] Sync weekly with Pandapple/ATL on alliance status

### Pandapple — War Captain + External Comms (Day-to-Day)
- [ ] War captain duties (lineup execution in-game)
- [ ] Day-to-day alliance communication
- [ ] Coordinate with bzap server / external clans
- [ ] Report alliance issues up to Menelaus

### Paunginoon — War Captain + Attendance
- [ ] War captain duties (lineup execution in-game)
- [ ] Track war attendance (sole owner)
- [ ] Maintain war roster
- [ ] Escalate no-shows / repeat absences

### ATL — External Comms (Backup / Specialty)
- [ ] Backup alliance liaison (cover for Pandapple)
- [ ] Outbound coordination with non-alliance servers
- [ ] Report up to Menelaus

---

## Tier 2 — Kion Officers

### Monday — Tower War Lead
- [ ] Open tower signups
- [ ] Send tower reminders
- [ ] Maintain tower roster

### NowhereMan — Internal Health
- [ ] Monitor clan morale + engagement
- [ ] Collect member feedback
- [ ] Run **internal** activities (in-clan only)

### Ynaguinid — External Events + Immortal Liaison
- [ ] Schedule **external** events with other clans (War Games, etc.)
- [ ] Schedule events **after** regular war calendar
- [ ] Sole point of contact for Immortal activities

---

## Tier 3 — Community & Recruitment

### Manawari — Discord Ops + Bot Monitoring
- [ ] Discord moderation + activity monitoring
- [ ] Facilitate clan events (run-of-show)
- [ ] **Bot monitoring:** suggest bot features, report bugs to Clan Leader
- [ ] Cross-officer comms coordination

### xIcy — Recruitment + In-Game Reminders
- [ ] Recruitment + social media campaigns
- [ ] Shadow War in-game reminders (uses lineup from Clan Leader)

### Nalimotko — Event Prize Coordinator
- [ ] Manage event prize pool
- [ ] Record winners (event log)

### Nutristar — In-Game Behavior + Prize Backup
- [ ] Monitor in-game behavior, relationships, factions
- [ ] Backup Nalimotko on prize coordination

---

## Workflow: Shadow War / VoB Lineup

```mermaid
flowchart LR
    A[Menelaus<br/>drafts lineup] --> B[👑 Clan Leader<br/>approves]
    B --> C[xIcy<br/>in-game reminders]
    B --> D[Pandapple / Pau<br/>execute in war]
    Pau2[Paunginoon<br/>logs attendance] -.->|post-war| A
```

---

## Events Pipeline — External vs Internal

External and internal events have **separate owners** to avoid overlap.

```mermaid
flowchart TD
    subgraph EXT[External Events — with other clans]
        E1[Ynaguinid<br/>schedules + contacts external clans]
        E2[Manawari<br/>runs event on the day]
        E3[Nalimotko<br/>handles prizes]
        E4[Nutristar<br/>backup + records]
        E1 --> E2 --> E3 --> E4
    end

    subgraph INT[Internal Events — clan-only]
        I1[NowhereMan<br/>proposes + runs]
        I2[Manawari<br/>Discord facilitation]
        I3[Nalimotko<br/>prizes if applicable]
        I1 --> I2 --> I3
    end
```

| Aspect | External Events | Internal Events |
|---|---|---|
| Owner | Ynaguinid | NowhereMan |
| Scheduling | After regular war calendar | Anytime, around clan health |
| Outside contact | Yes (other clans) | No |
| Discord facilitation | Manawari | Manawari |
| Prizes | Nalimotko (Nutristar backup) | Nalimotko (if applicable) |

---

## Member Monitoring — Split by Domain

To avoid four officers stepping on each other:

| Officer | Monitors |
|---|---|
| Paunginoon | War attendance only |
| NowhereMan | Morale / engagement / feedback |
| Manawari | Discord activity |
| Nutristar | In-game behavior, relationships, factions |

---

## Alliance / External Comms — Split by Function

| Officer | Function |
|---|---|
| Menelaus | Strategy + final decisions |
| Pandapple | Day-to-day alliance comms |
| ATL | Backup + non-alliance external servers |
| Ynaguinid | Event-only contact (no strategy) |

---

## Bot Ownership

| Role | Owner |
|---|---|
| Bot owner (admin, deploys) | 👑 Clan Leader (delegates to Menelaus) |
| Feature suggestions | Manawari |
| Bug reports | Manawari → Clan Leader |
| Bot operations | Menelaus |

---

*Last reviewed: 2026-05-02*
