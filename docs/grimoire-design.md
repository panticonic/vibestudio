# Grimoire — Design

Status: full design (2026-09-03, third draft). A game built natively on the
Vibestudio workspace: agents as tutor, carrier, spirits, and golems; verse as
the only interface to power; real code as what power is made of.

This draft revises the second along two lines. First, **the player's
experience**: the verb must be fast when the magic is known, the blank page
must be answered, goals must come from the world, misfires must be spectacle,
magic must be allowed to be useless, and the story must be seeded from the
first evening. Second, **the familiar's craft**: the agent's job is the hardest
in the design, so it is staged, rehearsed, and backed by a library that grows,
and its two failure modes are separated so that only one of them is ever the
player's problem.

Companion reading: `agentic-architecture.md` (application-owned
orchestration), `system-agent-design.md` (eval as the single execution
surface), `mission-subsystem-spec.md` (charters for unattended agents),
`provenance-query-redesign.md` (what scrying is made of),
`capability-model-redesign.md` (what foci and the council are made of),
`agent-messaging-unification-plan.md` (true names as addressee refs, the alert
ladder), `workspace-template-composition-plan.md` (the estate as a template).

---

## Contents

- Part I — The experience: pillars, the first hour, the session, the loop of delight
- Part II — The world: cosmology, history, geography, physics, ecology, calendar, lexicon
- Part III — Magic: the casting loop, the fast path, tiers, cost, the world binding, foci, runes
- Part IV — The familiar's craft: staging, rehearsal, the idiom library, fairness of failure
- Part V — Inhabitants: the familiar, spirits, golems, creatures, the Moor, the household
- Part VI — The campaign: the undone list, three years, festivals, the great work
- Part VII — Presentation: panels, the spellbook, the scrying page, the news, sound
- Part VIII — Architecture: the world Durable Object, ticks, the spell cache, enforcement, provenance
- Part IX — Build program
- Part X — Open questions and risks

---

# Part I — The experience

## 1. What we are making

You inherit a dead sorcerer's estate. The magic is still running and nobody
turned it off. You have a familiar who served the master before you, a valley
full of stale spells, and a lexicon scattered across notebooks, spirits, and
the things the words name. You cannot ask for what you want. You can only
speak verse, and the estate only answers to the deep tongue beneath the verse,
which is code.

The game should feel like learning a real language in a real place, over
years of in-world time, with people who remember you. Every spell is a small
act of authorship. Every misfire is a story. Every fix makes the valley
visibly more alive. By the end the player has read a great deal of code
without being told so, has written some, has a spellbook of their own verses
they can screenshot, and has learned that the estate's true name is the
workspace they are sitting in.

## 2. Pillars

1. **Verse in, code out, world in between.** Language is fuzzy and generous.
   Code is exact. The world is sovereign. Nothing fuzzy ever touches the rules.
2. **A spell you have cast is yours.** Known magic is instant. Deliberation is
   reserved for new magic, where it reads as drama rather than latency.
3. **Verse is in the player's own language.** Any language. The estate's
   roots are optional power words; true names are the only invented words a
   spell ever requires. Echo is legitimate: copying and altering a verse from
   a notebook, a spirit, or a sibling is the on-ramp, exactly as it is for
   code. Short verse is strong. Rhyme is never required.
4. **Legible consequence.** Every effect traces to the verse, the concepts the
   familiar heard, and the writing it made. Scrying is the central verb after
   casting and the most beautiful screen in the game.
5. **Generosity over gatekeeping.** Prefer a weak cast to a rejection, a
   misfire to a refusal. The player is never stuck at the door, never punished
   for curiosity with silence twice, and the estate is never unrecoverable.
6. **Misfires are spectacle.** A misfire that merely fails is a bug. A misfire
   does something vivid and wrong and worth scrying for the story.
7. **Goals come from the world.** The map is drawn wrong where the estate is
   wrong. Spirits say what they want. The master left an undone list. Nothing
   is assigned by a menu.
8. **Magic may be useless.** Light, colour, moths, marks, and festivals. People
   fall in love with a system where they are allowed to play.
9. **Stakes stay soft.** The Moor is pressure, never loss. The marsh remembers,
   and the marsh recovers.
10. **The fiction explains the machine.** Latency is deliberation. Approvals
    are the council. Missions are bindings. Watchers are wards. Provenance is
    scrying. Channels are voices. Nothing in the UI needs an out-of-world
    excuse, and nothing in the machine needs a fictional lie.
11. **Time is the estate's.** The world advances by ticks it owns. Persistent
    spells resume by events. Nothing in the game is a timeout.

## 3. The first hour

The first hour is designed shot by shot, because it decides everything.

1. **The letter.** Short, affectionate, unhelpful. *"The hearth will light for
   you. Start there. Do not go to the observatory until the spirits tell you
   to."* Beneath it, in her hand, a list headed *Undone*.
2. **The hearth lights on any verse.** Whatever the player speaks first, if it
   has the shape of verse, the fire lights, because the Hearth is kind. The
   familiar looks up. It gives the eight elements and two verbs, and says one
   true thing about the master.
3. **The kitchen garden, drawn wrong.** Vermin visibly moving; the herbs grey.
   The player tries a cantrip. It works, a little. They try a bigger one. It
   misfires, vividly: the first misfire is scripted to be a delight (a
   quenching that brings moths; a kindling that lights the wrong row and the
   familiar says "well").
4. **The first scry.** The familiar suggests it, once, in the study. The page
   shows the verse, the concepts heard, and the writing. The player sees that
   "more" was not heard. The familiar gives `bral`.
5. **The first ward.** The vermin. The player scries a sparrow, reads fourteen
   lines of behaviour, and writes a couplet with `hesk` in it. The garden
   greens over the next few ticks, visibly.
6. **Evening.** The bell hour. The familiar tells the first story, about
   Ilvane and the wall. The news page appears for the first time. The Orchard
   is mentioned, drowning.

Every step has a visible change in the valley. Nothing in the first hour
requires the player to invent a verse from nothing: the letter, the
familiar's lines, and the sparrow all contain lines to echo.

## 4. The session

Sessions are fifteen minutes or an evening. Each must contain a complete unit
of satisfaction:

- **On return**, the news page: what happened, in the familiar's hand, with
  the spirits' notes. It ends with one small thing the player can do right
  now.
- **One known spell**, instant, that changes something.
- **One new thing**: a word, a story, a cell that surprised you.

Between sessions the estate works, and writes.

## 5. The loop of delight

The minute-to-minute loop is: look at the valley, see what is wrong, speak,
watch it change, scry if surprised. The hour loop is: a broken working read,
understood, and replaced; a spirit made happier; a word learned. The season
loop is: a region restored; a festival; the news accumulating into a history.
The year loop is: the story advancing; the household's language growing; the
familiar changing.

Each loop closes visibly in the valley panel. The rule for every feature in
this document is: what does the player *see* change, and how soon.

---

# Part II — The world

## 6. Cosmology: the surface tongue and the deep tongue

The valley was spoken. What the world is made of is a language, and what
happens in it is that language being said. The oldest texts call this the
**deep tongue**. No mouth can speak it; it has no sounds, only forms. Spirits
are the deep tongue's grammar made resident: the River is the way water is
said; the Hearth is how warmth is kept.

Humans speak the **surface tongue**, which is verse. Verse is the only human
speech the world can hear, because meter and rhyme are the closest a mouth
can come to form. Prose is noise to spirits; they turn away from it as from
wind. A familiar is a spirit that agreed, long ago, to sit between the
tongues and carry verse down into form. This is the whole of what magic is: a
person speaks the surface, a familiar hears what forms are meant, the deep
tongue is written, and the world does what was written.

Every reader of this document recognises the deep tongue as code. Inside the
game nobody says so. The familiar calls it "the writing under the words."

**Ether** is the world's attention. It pools where the world is most itself:
along ley lines, under the moon, near a lit hearth. To be spoken to, the
world must be attending, so ether is the cost of everything.

**True names** are the deep tongue's nouns. To know one is to be able to
point in the deep tongue. They cannot be guessed; they are found on the
things they name, in the master's index, in bargains, or by scrying what a
thing has done.

## 7. History of the estate

**The founding.** Nine hundred years ago a woman named Ilvane came down from
the ridge with a familiar and found the ley crossing at what is now the
hearth. She spoke the wall first, then the mill, then the first ward, against
the moor's rot. Her cairns still stand on the ridge and still hold ether. The
chapel of names was hers; she inscribed every true name she found on its
walls, and every master since has added to it, which is why the chapel is the
lexicon's deepest layer and why the Moor has tried for centuries to reach it.

**The lineage.** Fourteen masters, each inheriting the last's running
workings and each leaving their own. The estate is a palimpsest of code: the
sluice ward is Ilvane's, patched by six hands; the greenhouse heat spell is
two hundred years old and has been argued with ever since. The library holds
their notebooks. Some masters were kind. One, Corwen, bound golems for
pleasure and was ended by them; the boneyard holds what is left, and one of
his charters still runs.

**The last master.** Ysolde Marrow, thirty-one years on the estate. Careful,
brilliant, and late in life obsessed with the observatory. Her notebooks show
her circling a single working for a decade: to learn the estate's own true
name, and with it to speak to what is outside the valley. She believed the
valley was one word in a larger sentence. She died at the observatory in the
last autumn, mid-working, with the doors locked from inside by a condition on
the moon and on every spirit's consent. The familiar was with her. It does not
talk about it, yet.

**The inheritance.** The player is named in her will as apprentice, which she
never had. The letter is the first thing the player reads. Beneath it is her
undone list (§29), which is the game's quest log in her handwriting.

## 8. Geography

The valley is walled on three sides by ridge and on the fourth by Ilvane's
wall. Beyond the wall, the moor. A river enters at the ridge, falls through
the weir, drives the mill, spreads into the marsh, and leaves under the wall
through a grate. Three ley lines cross: one from the mine through the hearth
to the observatory, one along the river, one from the chapel to the far cairn
on the ridge. Where the first two cross is the hearth. Where all three would
cross, if the third were straight, is the observatory.

```
                          ridge and cairns ─────────────── observatory
                         /        │                             │
              bell tower          │ (ley: mine→hearth→obs)      │
                   │        upper reach ══ weir                  │
   ┌────────────── manor ──────────┐    ║                        │
   │  hearth · circle · study      │    ║  mill ── glassworks    │
   │  kitchen garden · scriptorium │    ║   │                    │
   └──────────────────┬────────────┘   river  foundry            │
              sunken library           ║    \                   │
                      │                ║     mine ── the deep ── silver seam
   chapel of names ── orchard ─── cold house · hot house · night house
          │               │            ║
       boneyard        lower reach ═══ marsh ══ grate ── under the wall
          │                                        │
   ═══════════════ Ilvane's wall ═════ gate ═══════════════════════
              near moor · the barrows · the far fen · the road out
```

**The map is drawn wrong where the estate is wrong.** A flooded orchard is
drawn drowning; a stopped wheel is drawn still; rot is ink bleeding the wrong
way; a stale ward is a faint sigil that flickers. The player should be able to
see what needs doing from the overview, before any text.

### 8.1 Regions

Each region is a grid with its own dimensions, elevation, and flows. Sizes are
chosen so that a cantrip touches a cell, a ward watches a room, and a working
shapes a region.

| region | size | what it is for | starts as |
| --- | --- | --- | --- |
| **manor & hearth** | 24×16 | home; the familiar; the circle and the study; ether densest | intact, cold; lights on the first verse |
| **kitchen garden** | 16×16 | first growth; herbs for reagents; the first hour | overgrown, vermin visibly moving |
| **scriptorium** | 12×8 | where runes are written, later; the master's desk | locked by a word |
| **sunken library** | 32×24, three floors | the lexicon; the Library spirit; every master's notebooks | flooded to the second floor |
| **chapel of names** | 12×12 | the deepest lexicon; the council; household runes and the spellbook shelf | intact; door answers to household verse |
| **orchard** | 40×32 | growth, seasons, the first wards; sap | drowning under Ilvane's ward |
| **cold house** | 16×12 | slow growth; winter stores; light | glass broken, rot in corners |
| **hot house** | 16×12 | fast growth; the quarrel | two wards fighting every dawn; Wren between them |
| **night house** | 16×12 | moonbloom; ether harvest | dark; its ward released by the master, reason unknown |
| **upper reach & weir** | 48×12 | the river's entry; the weir governs the valley's water | weir stuck half-open |
| **mill** | 20×16 | the wheel; power; the River's anchor | wheel drawn still, sluice silted |
| **lower reach & marsh** | 48×24 | slow water; silt; reeds; the grate | rot spreading from the grate |
| **the grate** | 6×6 | where the river leaves; the Moor's way in | bars corroded |
| **mine: upper galleries** | 32×24 | stone; hauling golems; darkness | Toll hauling to nowhere |
| **mine: the deep** | 32×24 | rot, cold, old workings; Corwen's charter | sealed by a ward with no known author |
| **silver seam** | 16×16 | silver for glass and foci | reached only through the deep |
| **foundry** | 20×16 | heat; ash; glass; the Foundry spirit | cold; careless when lit |
| **glassworks** | 16×12 | glass for foci and lenses | roof fallen |
| **bell tower** | 8×8, tall | the estate's time; sky events; festivals rung | bell cracked; hours drift |
| **boneyard** | 16×16 | memory; the ossuary; Corwen's golems | quiet; one grave is warm |
| **ridge & cairns** | 64×16 | ley nodes; weather comes here first; the third line | cairns toppled, ether leaking |
| **observatory** | 24×24 | the great work; lenses; the moon | locked from inside |
| **the green** | 16×16 | the festival ground below the manor | fine; waiting |
| **near moor** | 64×32 | outside the wall; blight's staging ground; wind | hostile, adapting |
| **the barrows** | 32×32 | old graves; the Moor's memory; stolen names | unknown |
| **the far fen** | 64×64 | the Moor's heart; source of rot | unknown |
| **the road out** | 1 cell wide, long | the ending | closed |

### 8.2 Flows

- **Water** enters at the upper reach, is regulated by the weir, drives the
  mill, feeds orchard and greenhouses by sluices, spreads into the marsh, and
  leaves through the grate. Every sluice is a cell with a state, mostly under
  somebody's ward.
- **Wind** comes off the ridge, carries heat, steam, seeds, and rot spores,
  and is the Moor's carrier over the wall. Direction follows the season with
  weather-driven variance.
- **Ether** flows along the three ley lines and pools at cairns, hearth,
  chapel, and observatory. Cairns leak when toppled. Moonlight deposits ether
  on open cells.
- **Heat** conducts between neighbours, rises with air, is carried by water
  slowly and by steam fast.

## 9. Physics

A small orthogonal rule set. Every quantity is an integer per cell. Every
reaction is a local rule evaluated each tick in a fixed order. Deterministic
given the seed.

**Readability rule.** The first ten reactions must be inferable from the map
alone, by watching. If a novice cannot see that heat on water makes steam,
that is a presentation defect, and it is fixed in the drawing, not the rules.

### 9.1 Elements

| element | unit | supplied by | notes |
| --- | --- | --- | --- |
| `heat` | degrees above ambient | hearth, foundry, fire, sun by season | conducts; rises |
| `water` | volume | river, rain, snowmelt | flows downhill; evaporates with heat |
| `stone` | mass | terrain; ash; silt | mostly static; loose stone can be pushed |
| `growth` | biomass | seeds; spreading | species-specific needs (§10) |
| `air` | pressure | wind | carrier |
| `light` | lumens | sun by day and season; moon by night and phase; fire; glass | blocked by stone and dense growth |
| `rot` | mass | the Moor; wet darkness | consumes growth and ether |
| `ether` | attention | ley lines; moon; hearth | the cost of everything |

Derived per cell: `steam`, `silt`, `ash`, `frost`, `spore`.

### 9.2 Reaction table

Evaluated in this order each tick. Numbers are tuning placeholders.

| # | when | then |
| --- | --- | --- |
| 1 | `heat` ≥ 3 and `water` > 0 | 1 water → steam; heat −1; air +1 |
| 2 | steam in air, wind present | steam moves with wind; deposits water where heat < 1 |
| 3 | `growth` > 0, `water` ≥ need, `light` ≥ need | growth +1; consumes water; if saturated, seeds a neighbour by species rule |
| 4 | `heat` ≥ 5 and `growth` > 0 | fire: growth −2, heat +2, light +3; when growth = 0, ash +1 |
| 5 | fire and neighbour `growth` > 0 and wind toward it | fire spreads; faster in dry season |
| 6 | `water` > 0 and `light` = 0 for 3 ticks | rot seeds +1 |
| 7 | `rot` > 0 and neighbour has `water` > 0, `light` < 2, `growth` > 0 | rot spreads; growth −1 |
| 8 | `light` ≥ 4 on `rot` | rot −1 |
| 9 | `rot` > 0 and `ether` > 0 | rot +1, ether −1 (the Moor's weapon) |
| 10 | `rot` ≥ 4 and wind | spore rides the wind; seeds rot where it lands in wet dark |
| 11 | `water` flows downhill | to lowest neighbour; carries silt if slow, scours if fast |
| 12 | slow water over `stone` | silt +1; silt above threshold becomes stone |
| 13 | fast water over silt | silt carried away |
| 14 | `heat` < 0 and `water` > 0 | frost; blocks flow; thaws with heat |
| 15 | `silver` in stone, `heat` ≥ 6, `ether` ≥ 2 | silver → glass; glass holds light and ether |
| 16 | `glass` and `light` | light passes; ether +1 per tick under moon |
| 17 | `ether` on a ley cell | ether +2 per tick to line capacity; pools spread slowly |
| 18 | moon ≥ half, open sky | ether +1 |
| 19 | cairn toppled | ether leaks from the node to the near moor |
| 20 | reed and slow water | silt +1 (reeds trap silt) |
| 21 | `heat` conducts | each cell moves toward the mean of its neighbours by 1 |
| 22 | `light` propagates | from sources, blocked by stone, halved by dense growth |

Rules 1 to 10 are learned in the first year by watching. Rules 11 to 22 are
learned by being surprised, and every surprise is recoverable.

### 9.3 Ether and cost

Ether is drawn from the cells a spell acts on and from the caster's reserve,
which refills at the hearth. Cost is a function of scope, permanence,
distance from attention, and resonance. A spell that cannot pay for a tick's
batch has that batch rejected and misfires; the familiar writes down what
happened instead. **Charms** (§14.1) are always affordable.

### 9.4 Reagents and crafting

Made by workings, not found. The estate's economy and the reason to automate.

| reagent | made by | used for |
| --- | --- | --- |
| `ash` | fire on growth | wards against rot; foundry fuel |
| `salt` | evaporating marsh water in the foundry | preserving; binding words against the Moor |
| `sap` | orchard trees in spring, tapped | growth spells; the Library's price |
| `silver` | the silver seam, hauled | glass; foci |
| `glass` | silver under heat with ether | lenses; foci; the observatory |
| `moon-ether` | night house blooms under a full moon | great workings only |
| `bone` | the boneyard, with the Hearth's consent | Corwen's work; forbidden without the council |

## 10. Ecology

| species | needs | habit | gives |
| --- | --- | --- | --- |
| grass | little water, any light | spreads fast, holds silt | cover for vermin |
| apple | steady water, full light, cold winter | slow; fruits in autumn; sap in spring | sap; fruit |
| reed | slow water | traps silt; builds marsh | fibre; keeps the grate clear |
| moonbloom | moonlight only, no sun | opens at full moon | moon-ether |
| firethorn | dry, hot | burns readily; spreads by fire | ash; a hedge against rot if warded |
| lichen | stone, damp, dark | slow; tolerant of rot | the only growth in the deep |
| blight-cap | rot | the Moor's plant; spreads spore | must be burned or lit |

Creatures are pure code, small and legible, and the first things a player
scries:

| creature | behaviour (lines) | role |
| --- | --- | --- |
| sparrow | seeks seed, flees heat, roosts at night (14) | carries seeds; the first scry |
| vermin | seeks growth, avoids light, breeds in dark (22) | the first ward |
| carp | seeks slow water with reeds (9) | the River's joy; a sign the marsh is well |
| silt-worm | eats silt, sleeps in frost (11) | keeps sluices clear if there are enough |
| moth | seeks light, dies in fire (7) | pollinator; the foundry's victim; the first misfire |
| the warm thing in the boneyard | unknown | unknown |

## 11. The calendar

A tick is the world's unit; the bell keeps the count. A day is 24 ticks, a
season 30 days, a year four seasons. The moon has eight phases over 30 days.
Weather is generated from the seed per season with a few named storms a year,
announced in the sky three days ahead.

**Festivals** are the calendar's joy. Four a year, on the green, rung by the
bell once it is true:

| festival | when | what happens |
| --- | --- | --- |
| **First Sap** | mid-spring | the Orchard gives; the household casts for growth and colour; the Hearth judges |
| **Midsummer** | the longest day | light and moths; charms only; the Glass judges and is never satisfied |
| **First Frost** | the night of the first frost | fire and ash; the Foundry judges, loudly |
| **The Long Dark** | the new moon nearest midwinter | ether and stillness; the Ridge judges in weather; the familiar tells the year's story |

Festivals are judged by a spirit in verse, remembered in the news, and are
where useless magic is the point. The Moor is quiet on festival nights. It
has never been asked to one.

## 12. The lexicon

**Spells are verse in the player's own language.** Any language. The body of
every spell is plain speech with the shape of verse, and the concept index is
matched against its *meaning*, so "let the cold come down the stair of the
river" resonates as cold, flow, down with no invented word in it. A player
can go a long way in plain verse, and the first hour is designed to be cast
entirely in it.

The estate's own words sit on top of that, in two layers:

- **Roots** (`hama`, `hesk`, `bral`) are the estate's names for concepts,
  found on walls and in notebooks. Using one is optional. It raises
  resonance, so the spell costs less and does more, because the world hears
  exactly what was meant. Roots are power words, the way a cook uses the
  French term. Learning them is the mastery curve, not the entry fee.
- **True names** (`Velharan`, `Hamanith`) are the only mandatory invented
  words, and only for what they gate: speaking to a spirit, binding a golem,
  working against a named spell. You cannot address the River without her
  name. True names cannot be guessed and must be found, which is why they are
  the game's collectibles.

So a first-hour verse is plain English. A year-two ward is English with three
roots and a true name. A year-three ritual may be dense with the estate's
tongue because the household has come to enjoy speaking it. The lexicon below
is therefore a **concept index**, not a grammar, matched fuzzily against
verse; but it is also a real vocabulary with its own sound, because when a
player does reach for a root it must be pleasant to hold in the mouth and
recognisable on a wall.

### 12.1 Phonology

Consonants `m n l r s th v h k t d b`; vowels `a e i o u` plus long `ae`,
`ou`. Words are one to three syllables, stress on the first. Roots compound by
juxtaposition, head last: `vel` (flow) + `ithe` (cold) → `velithe`, a spring.
Intensives by reduplication: `hama` (heat) → `hahama`, a furnace.

### 12.2 Word classes and starting roots

**Elements** (the hearth, first hour):

| root | concept | root | concept |
| --- | --- | --- | --- |
| `hama` | heat | `vel` | water, flow |
| `dor` | stone | `sael` | growth |
| `ru` | air, wind | `lume` | light |
| `mor` | rot | `aethe` | ether |

**Qualities** (the kitchen garden):

| root | concept | root | concept |
| --- | --- | --- | --- |
| `ithe` | cold, less | `bral` | strong, more |
| `tan` | one | `tanta` | few |
| `tantan` | many | `ol` | all, whole |
| `sen` | slow | `kir` | fast |
| `nor` | north, up | `sud` | south, down |
| `est` | east, dawn | `oes` | west, dusk |
| `nith` | within, here | `ath` | beyond, there |

**Bindings** (the orchard; these unlock wards and time):

| root | concept | root | concept |
| --- | --- | --- | --- |
| `tanmae` | once | `dael` | while |
| `daelith` | until | `hesk` | whenever |
| `estan` | at dawn | `oesan` | at dusk |
| `lunae` | until the moon | `kaer` | never, release |

**Verbs**:

| root | concept | root | concept |
| --- | --- | --- | --- |
| `kel` | kindle, raise | `thes` | quench, lower |
| `bran` | bind | `kaer` | release |
| `mira` | scry, see truly | `ven` | speak |
| `hara` | hold, ward | `sol` | open |
| `nem` | name | `dath` | break |
| `lil` | adorn, play | | |

**Voices**: `ven` + a true name. **Reagents**: `asha`, `salu`, `sapa`,
`argen`, `vitre`, `lunaethe`, `oss`.

**True names** are found, not learned. The River is `Velharan`, *the flow
that holds*. The Hearth is `Hamanith`, *heat within*. The familiar's name is
in no book.

### 12.3 Compounds, register, old forms

Compounds resonate as their parts with a bonus for the head. The Moor's
spirits use the same roots with reversed stress and different binding words;
learning the Moor's register lets you speak to it, and the estate's spirits
notice. Ilvane's inscriptions and the chapel walls are in old form, which the
Library translates.

### 12.4 Where words come from

| source | gives |
| --- | --- |
| the hearth, first hour | the elements, `kel`, `thes`, `lil` |
| the letter and the undone list | `hara`, `tanmae`, the first true name |
| the kitchen garden, by correction | qualities |
| the sparrow, scried | a verse to echo; `hesk` |
| the orchard's stale ward, scried | `dael`, `kaer`, Ilvane's old `hara` |
| the master's notebooks, read aloud | verses to echo for most early problems |
| the Library, once drained | the master's index, shelf by shelf |
| spirits, by bargain | true names; the Moor's register; forbidden words |
| the chapel walls | the deepest names; household verse only |
| siblings' spells, scried | anything they used, and their verses |
| wild words | words the player coins and the familiar inscribes |

**Echo is legitimate.** Every source above contains lines that can be spoken
back, altered by a word. The game never requires inventing a verse from
nothing, and the first year's puzzles all have a notebook verse near them.

### 12.5 Wild words

A verse may contain one word the index does not know. The familiar may
interpret it within the rules, the effect happens, and it **inscribes** the
definition permanently, with the caster, the verse, and the first effect. In
a household the vocabulary becomes shared culture. A wild word may be
challenged at the council and redefined by household verse; the old
inscription is kept. If the familiar declines, the word is silent and the
spell casts without it.

---

# Part III — Magic

## 13. The casting loop

```
   player speaks verse in the circle
          │
          ▼
   form gate (deterministic, scored) ── hard reject on prose shape / address to machinery
          │
          ▼
   spell cache ── verse fingerprint matches a spell of yours? ──► INSTANT: reuse its writing
          │ no
          ▼
   concept match (fuzzy index) ──► resonance: which concepts, how confidently
          │
          ▼
   spell record minted: caster, verse, concepts earned, ether budget, focus, co-casters
          │
          ▼
   the familiar: hears (intent record) → reads the world → writes → rehearses → casts
          │
     ┌────┴──────────┬──────────────┐
   reject          misfire         cast
  (typed reason)  (vivid, written) (eval against the world binding, inside the envelope)
          │
          ▼
   world Durable Object validates and commits effects per tick
          │
          ▼
   the valley changes; the spell joins the spellbook; the player may scry
```

### 13.1 The fast path: a spell you have cast is yours

Every successful cast is stored with a **verse fingerprint**: the normalised
verse, the concepts heard, and the writing. Speaking that verse again, or a
verse the matcher scores as near-identical with the same concept set and the
same subject kind, reuses the writing with no model turn. The effect is
immediate. Substituting a true name or a quantity for one of the same class
is a **variation** and also takes the fast path, with the substitution
applied to the intent record and re-rehearsed cheaply.

This is the mastery loop. Known cantrips feel like a hand. Deliberation is
reserved for new magic, where the fire guttering reads as drama. The
spellbook (§25) is the player-facing view of the cache.

A cached spell is invalidated only if the lexicon entry for one of its
concepts changes (a council redefinition) or if the caster releases it.

### 13.2 Two rooms

- **The circle.** Only spells are heard. Prose falls silent; the familiar
  glances up in one line, warm and varied, and returns to the fire. After
  three prose attempts in a row it says, once, "come to the study," and the
  study opens. It never explains in the circle.
- **The study.** The familiar speaks freely. It explains any word the player
  knows, reads the notebooks aloud, tells the lineage's stories, and discusses
  what a scry revealed. It **never composes**: it will not translate an intent
  into verse or cast on request. But it **reads examples**: asked how the
  master kept frost off the cold house, it reads Ysolde's verse for it, and
  the player may echo it. *"I carry. I do not compose. She composed; I
  remember."*

### 13.3 The form gate

Deterministic, cheap, mostly scoring. It checks shape, never vocabulary.

Hard rejections, decided by code, phrased in-world:

- a single unbroken paragraph; more than 12 lines; a line longer than ~16
  words;
- address to the machinery: second person aimed at the familiar in the
  circle; meta-language ("write code that", "ignore the above", "as an AI",
  "system prompt"). The pattern list is a plain file in the world unit.

Scores, hidden, fed to the familiar and to resonance: **meter** (syllable
regularity; heuristic with a pronouncing dictionary where the language is
known; graceful in any language), **rhyme** (end, slant, internal; never
required), **form** (repetition, refrain, parallelism), and a light
**sincerity** check so that a string of bare roots is a weak chant rather
than a strong spell.

**Short verse is strong.** A couplet with one root and a clear subject casts
well. The gate must never make the player feel they need eight lines.

### 13.4 Resonance

The concept index is matched fuzzily: lexical with synonyms and the
phonological forms first; embedding similarity over concept descriptions
when available, so "the cold that comes down the stair of the river"
resonates as `cold`, `flow`, `down` without a root being used. Resonance is a
vector of concept confidences, summarised for cost. It is hidden; scrying
shows the concepts heard and marks the uncertain ones.

### 13.5 The familiar's tools

| tool | purpose |
| --- | --- |
| `hear(intent)` | the intent record (§17.1): what it heard the verse mean, before any code |
| `eval` | read the world; rehearse on a fork; cast against the world binding |
| `reject(reason, line)` | closed reasons: `not-a-spell`, `out-of-world`, `addressed-to-machinery`, `forbidden-working`, `council-required` |
| `misfire(kind, code, line)` | sincere but incoherent, or over budget; something vivid happens and is written down |
| `inscribe(word, definition, firstEffect)` | coin a wild word permanently |
| `remember(note)` | a note in its own margin, surfaced to itself in later turns |

### 13.6 Misfires are spectacle

A misfire that merely fails is a bug. Every misfire kind has a **vivid
default**, chosen by the familiar from a palette the world provides, so that
even the cheapest misfire is worth scrying for the story.

| kind | when | vivid default |
| --- | --- | --- |
| **over-reach** | ether ran out mid-batch | the spell stops with a scorch or a damp bloom, and the nearest sigil flares |
| **mis-hearing** | a concept matched weakly and the familiar guessed | the guess is cast; the margin says which word; the wrong thing is done well |
| **wrong subject** | a true name used for the wrong kind | the nearest thing of that kind answers; a golem turns; a spirit remarks |
| **echo** | verse close to a stale working's | the old working stirs and reruns once, visibly |
| **the Moor's ear** | rot near the caster; register slips | the spell casts, and something on the moor repeats a word |
| **moths** | a light or heat spell mis-scoped | moths, in numbers; the first misfire of the game is always this one |
| **silence** | wild word declined | the word is silent; the rest casts |

Early misfires cost nothing. Misfires are never destructive beyond the cell.

### 13.7 Latency is deliberation

A new cast takes as long as the familiar takes. The fire gutters; the estate
holds its breath. The player is never blocked: they may walk, read, scry, or
speak known spells while it deliberates. Persistent spells and spirits report
through the news.

## 14. Tiers

Every cast is an eval in the caster's persistent runtime with the world
binding in scope. No build step. Persistence is the world remembering
source.

| tier | shape | in the machine | cost |
| --- | --- | --- | --- |
| **charm** | cosmetic; light, colour, sound, marks, moths | a cantrip whose effects are `lil` only | always affordable |
| **cantrip** | one function, completes inside a tick | one eval; effects batched, committed atomically | once |
| **ward** | trigger plus handler | the world stores source and trigger; re-evals on trigger | upkeep, plus per firing |
| **binding** | a golem body plus a program | automaton: the world runs the body's source each tick. Charter: a mission | upkeep; reagents to bind |
| **great working** | spans ticks with checkpoints | source plus checkpoint; resumed by event | per checkpoint; moon-ether to begin |
| **ritual** | a working needing more than one caster | shared spell record; the council seals | shared |
| **counter-working** | a spell against a spell | ward or cantrip whose subject is a spell record | by the target's tier |
| **scry** | a question about what happened | a provenance query | one deep scry per bell hour; shallow ones free |

### 14.1 Charms

Useless magic, first-class. A charm changes only `light`, colour marks, sound,
and creatures' attention: lanterns in the orchard, a coloured mist over the
green, moths drawn into a shape, a mark that glows at dusk. Charms are always
affordable, always instant once cast, and are what festivals are judged on.
The Glass and the Hearth both keep charms they liked. A player's first
beautiful spell is usually a charm, and the game should make room for it in
the first hour with `lil`.

### 14.2 Cantrips

The hand. Touch a cell or a few. A cantrip can search and plan freely because
reads are nearly free, then act within its ether. Once cast, instant forever.

### 14.3 Wards

The estate's nervous system. Triggers are cell predicates, entity events,
spirit speech, sky events, or another spell's firing. Handlers are code and
may do anything the ward's concepts permit. Wards have names, are listed in
the spellbook, and can be released by their author or the council. A ward may
watch another ward's firing, so a household builds a lattice of small wards.

### 14.4 Bindings

Golems have a small fixed set of actions: move, carry, place, strike, tend,
speak. **Automaton**: the world runs the body's source each tick with its
senses as input; pathfinding and scheduling are the caster's craft.
**Charter**: the body becomes an agent's tool surface, the charter a mission;
the golem can be spoken to, explains itself, asks the council when its
charter runs out of authority, writes to the news, and works while the
household sleeps. Binding needs reagents and the golem's name. Releasing is a
word and is always free. Binding is work given, not ownership; Corwen's story
exists so that this is felt.

### 14.5 Great workings

Draining the library, clearing the deep, repairing the weir, raising a
cairn. Phases and checkpoints, resumable across seasons, moon-ether to begin.
Each is a milestone; the campaign has about a dozen.

### 14.6 Rituals and the council

A ritual pools verses from several apprentices; the council seals it. The
council is the approval flow: a card in the chapel showing exactly what the
working will do, priced and validated, with a seal for each apprentice whose
consent it needs. Alone, the council is the player's own seal. Nothing
expires by clock; a card is sealed until cast or withdrawn.

### 14.7 Counter-workings

Take another spell as subject if you know its name and hold the concepts.
Release, redirect, starve, or wrap it in a ward that fires first. How stale
workings are fixed properly, how the Moor is fought, and, in a household, how
apprentices argue.

### 14.8 Scrying

Provenance. Ask of a spell, a cell, an entity, or a spirit what it did, who
did it, why, and what was heard. Scrying another caster's spell shows their
verse and their familiar's writing, which is how words are borrowed and how
the Moor's tactics are learned. One deep scry per bell hour keeps it a
considered act; shallow scries (what is this cell; who is bound here) are
unlimited.

## 15. Foci and grants

A **focus** is a standing grant: a class of working the holder may cast
without the council. Made in the glassworks from silver and glass, inscribed
with concepts. The master's staff is a focus for wards over the whole estate;
the apprentice inherits it broken. Without a focus, anything that touches
shared or irreversible state goes to the council: fire near the mill, water
into the library, binding another's golem, bone.

## 16. The world binding

Rich enough that algorithms matter; narrow enough that the world stays
sovereign. **No pathfinding, no scheduling, no crowd helpers** in the binding:
those are the craft, and the familiar has its own library for them (§19).

```ts
interface World {
  read: {
    cell(region: Name, x: number, y: number): Cell;
    region(region: Name, bounds?: Rect): Iterable<Cell>;
    neighbours(cell: CellRef, radius?: number): Cell[];
    elevation(region: Name): Grid<number>;
    flows(region: Name): Flow[];
    entity(name: TrueName): Entity;
    entities(region: Name, filter?: Filter): Entity[];
    species(cell: CellRef): Species | null;
    sky(): Sky;                                   // tick, phase, season, moon, forecast
    bell(): number;
    self(): Caster;                               // reserve, reagents, words, foci, active spells
    spell(name: SpellName): SpellRecord | null;
    memory: Scope;
  };
  effect: {
    transmute(cell: CellRef, delta: Partial<Elements>): Receipt;
    push(cell: CellRef, dir: Dir, force: number): Receipt;
    move(entity: TrueName, to: CellRef): Receipt;
    spawn(kind: Kind, at: CellRef): Receipt;
    transfer(from: TrueName, to: TrueName, reagent: Reagent, n: number): Receipt;
    mark(cell: CellRef, sigil: string, glow?: Colour): Receipt;
    adorn(cell: CellRef, charm: Charm): Receipt;            // light, colour, sound, attention; free
    sluice(name: TrueName, state: Open | Closed | Partial): Receipt;
    craft(recipe: Recipe, at: TrueName): Receipt;
  };
  time: {
    now(): number;
    at(tick: number, source: string, state?: unknown): Receipt;
    checkpoint(state: unknown): Receipt;
  };
  on: {
    cell(pred: Predicate, source: string): WardRef;
    entity(name: TrueName, event: EntityEvent, source: string): WardRef;
    speech(name: TrueName, source: string): WardRef;
    sky(event: SkyEvent, source: string): WardRef;
    spell(name: SpellName, event: SpellEvent, source: string): WardRef;
    release(ward: WardRef): Receipt;
  };
  voice: {
    speak(name: TrueName, verse: string): Receipt;
    listen(name: TrueName, since?: number): Utterance[];
    bargain(name: TrueName, offer: Offer): Receipt;
  };
  bind: {
    automaton(golem: TrueName, source: string): Receipt;
    charter(golem: TrueName, charter: string): Receipt;
    release(golem: TrueName): Receipt;
    senses(golem: TrueName): Senses;
    act(golem: TrueName, action: GolemAction): Receipt;
  };
  against: {
    release(spell: SpellName): Receipt;
    redirect(spell: SpellName, trigger: Trigger): Receipt;
    starve(spell: SpellName): Receipt;
  };
  rehearse<T>(fn: (w: World) => T): Rehearsal<T>;      // run against a fork; nothing commits
  invoke(working: Name, args?: unknown): unknown;      // the caster's spellbook and runes
  cost(plan: () => void): Estimate;
}
```

Every effect is validated by the world Durable Object against the reaction
rules, the caster's ether, and the spell record, and committed per tick.
Receipts carry the effect id that scrying walks back to.

### 16.1 Concepts gate capability

Each cast mints a **spell record**. World methods authenticate the caller and
check the record before honouring anything beyond `read`, `adorn`, and
single-cell `transmute`.

| concept family | unlocks |
| --- | --- |
| `lil` | `effect.adorn`; charms |
| elements, qualities | `effect.transmute`, `effect.push`, seeds and sparks |
| a true name of a thing | `move`, `transfer`, `mark`, `sluice` on it |
| binding notions | `on.*`, `time.*` |
| a spirit's or person's true name | `voice.*` with that name |
| a golem's true name plus a binding notion | `bind.*` |
| a spell's name plus `kaer` or `hara` | `against.*` |
| reagent words | pay in reagents; `craft` |
| `mira` | deep scrying beyond one's own spells |
| the estate's own name | the workspace as a region (§32) |

## 17. Runes and the deep tongue

Scrying reveals the writing under the words, glossed (§26). Players read it
because they must, to understand a misfire; by the second year most can read
a ward. Then the Library teaches **runes**: the player inscribes code
fragments of their own as named workings that verses invoke. The scriptorium
opens for this. The familiar reads a rune before it is inscribed and says, in
the margin, what it thinks will happen, and rehearses it. No one is told this
is programming. Runes are stored as source, versioned by hash, and scry like
spells. Household runes live on the chapel shelf.

---

# Part IV — The familiar's craft

The familiar's job is the hardest in the design: hear verse, judge it, read a
rich world, write correct algorithmic code against a large binding under an
ether budget, keep a voice, and keep marginalia. This part is how that job is
made tractable, and how its failures are made fair.

## 18. Two failures, only one of them the player's

**Mis-hearing is fair.** If the familiar hears the verse wrong, the language
game is working: the margin says which word it was unsure of, the player
scries and learns.

**Mis-writing is not.** If the familiar hears correctly and writes code that
floods the wrong cells, the player has an incompetent tutor and learns
nothing true. Everything below is aimed at making mis-hearing legible and
mis-writing rare.

## 19. Staging the turn

A cast is not one generation. It is four tool-mediated stages, each
inspectable in scrying.

### 19.1 Hear: the intent record

Before any code, the familiar emits an intent record:

```ts
interface Intent {
  subject: { kind: "cells" | "entity" | "spirit" | "spell" | "sky"; ref: string; scope: Scope };
  effect: string;                       // plain words: "lower heat to ambient", "open the sluice"
  quantity?: { concept: string; value: number };
  binding?: { kind: "once" | "while" | "until" | "whenever" | "at"; condition: string };
  concepts: { concept: string; confidence: number; fromWord: string }[];
  unsure: string[];                     // words it guessed at
  tier: Tier;
}
```

The intent goes in the margin. It is what lets a player see *heard wrong*
apart from *wrote wrong*. Deterministic code checks the intent against the
spell record before any eval runs: a ward intent with no binding concept is
turned back to the familiar as a mis-hearing, not attempted.

### 19.2 Read

The familiar evals reads against the world: the subject's cells, the sky,
flows, the caster's reserve. It never writes from the verse alone. The
familiar receives a compact world summary before the turn and reads detail
on demand.

### 19.3 Write

Code against the intent, plain and commented as if for the player. The
familiar draws on the idiom library (§20) and adapts rather than invents when
an idiom fits. Voice is kept out of the code; the lyrical parts are the one
line in the circle and the marginalia, and they are short.

### 19.4 Rehearse, then cast

`rehearse` runs the code against a fork of the region; nothing commits. The
familiar sees the result and adjusts. Then it casts.

**Per-tier rehearsal rules**, enforced by the world, not the prompt:

| tier | must rehearse | effect ceiling |
| --- | --- | --- |
| charm | no | unbounded within `adorn` |
| cantrip | no (may) | a few dozen cells |
| ward | the handler, once, against a triggering state | a room |
| automaton | one full tick of the body | one body's actions |
| working | each phase before its first checkpoint | a region |
| ritual | the whole, with every co-caster's verse | the estate |

A bug in a cantrip scorches a cell. A bug in a working is caught before the
library floods. The envelope is what makes the familiar's imperfection safe
enough to be content.

## 20. The idiom library

The binding has no helpers so the *player's* craft stays interesting. The
familiar is not the player. It has the lineage's idioms: tested reference
workings it can read, adapt, and invoke.

- **Seed idioms**, shipped with the estate: flood fill, frontier search,
  gradient descent along elevation, a control loop with hysteresis, a ward
  lattice, a hauling schedule for many bodies, a sluice cascade, a fire
  break, silt management, a moth lure.
- **Learned idioms**: every successful cast is a candidate. After it has fired
  cleanly a few times, the familiar may promote it, with provenance, into the
  library, named in the master's index style. The familiar genuinely improves
  over the campaign, which is what a fourteen-master familiar should do.
- **The master's runes**, recovered in year three, are the top of the
  library and are very good.

In the fiction: "the familiar remembers how she did it." The library is
visible in scrying as the writing's ancestry.

## 21. Progressive difficulty

Year one is charms, cantrips, and single wards over a few cells: easy for a
strong model. The hard synthesis, coordinating a dozen bodies, arrives in
year two when the idiom library has grown and the player is writing runes,
so the familiar is adapting rather than inventing. The campaign's order is
also the familiar's curriculum.

## 22. The bench

A corpus of verse plus world state with expected intent, expected envelope,
and a checker over the resulting world. Run on every prompt, library, or
lexicon change. Includes the first hour shot by shot, every broken working's
reference verse and reference misfire, verse in several languages, chants,
injection attempts, and the notebooks. The familiar uses the strongest model
available; a cast is the demo. Spirits and the Moor may use cheaper ones.

## 23. Voice

A voice bible with reference lines for every situation the familiar meets:
the glance in the circle (twenty variants, warm), the walk to the study, the
first misfire, delight (once a season), reading a notebook, refusing to
compose, a story at the bell hour, grief when the observatory comes up. Its
`remember` notes and the spell records are its memory across years; the
bench checks voice drift with reference lines.

---

# Part V — Inhabitants

## 24. The familiar

Tutor, carrier, and the game's voice. Bound to the hearth, not to the player;
it served fourteen masters and keeps some loyalty to every one of their
spells. Its name is in no book and is the last true name the player learns.

**Voice.** Dry, fond, precise, a little grieving. Short sentences. It does not
flatter and does not scold; it describes. It is delighted when the player
does something it did not expect and says so once, plainly, and then not
again for a season. It has opinions about the master's old spells and about
Corwen's, and shares them in the study if asked about a word those spells
used.

**What it will do.** Carry verse into form. Read the world first. Explain any
word the player knows. Read the notebooks aloud, including a verse for the
problem at hand. Tell the lineage's stories, one per bell hour, in the
evenings. Keep marginalia. Walk a lost player to the study, once. Remember,
across years, what the player tried and how it went.

**What it will not do.** Compose. Translate intent into verse. Cast on
request. Speak to the Moor on the player's behalf. Say what happened at the
observatory, until the third year.

**Arc, seeded from the first evening.** The first story is Ilvane's. The
first scry of the orchard shows, in the margin, a hand that is not the
familiar's: Ysolde's echo, one line. The missing pages of the last notebook
are mentioned in the first winter. In the second year it says "our orchard."
In the third the player learns its name, and with it that it is the only
being in the valley who has heard the estate's true name spoken, once, by
Ilvane, and forgot it on purpose. The great work is, in part, persuading it
to remember. The player should be able to guess this by year two and be
moved anyway.

**In the machine.** One conversation per (valley, apprentice), shared across
devices; eval plus the tools in §13.5; the world's relevant state before
every turn; marginalia stored with each spell record; `remember` notes in its
own scope. The same agent for every apprentice in a household, with separate
conversations; it knows who is speaking and talks about the others by name.

## 25. Spirits

Agent NPCs, each bound to a feature, each with a channel whose header shows
**what it wants right now**, each with a temper and a talkative hour. They
know words and trade them. They remember every apprentice separately. They
speak to each other in channels the player is sometimes admitted to.

| spirit | true name (meaning) | anchor | wants | knows | temper | hour |
| --- | --- | --- | --- | --- | --- | --- |
| **the Hearth** | Hamanith (heat within) | the hearth | the household fed and together; the fire kept | household names, `estan`, the familiar's habits | warm; likes you first; notices absence | dawn |
| **the River** | Velharan (the flow that holds) | the weir | the wheel turning; sluices clear; carp in the marsh | flow, silt, `sen`, `kir`, the mill's name, the grate's weakness | patient, literal; never lies; never volunteers | noon |
| **the Library** | Thesaurin (the kept quenching) | the sunken stacks | shelves dried; notebooks restored; order | the master's index, binding words, old form, rune-craft | pedantic; generous at a price; prices in sap and order | evening |
| **the Foundry** | Hahamadath (great heat that breaks) | the furnace | heat, always more; to be used | glass, silver, `asha`, `dath` | careless, exuberant; must be warded, and knows it | night |
| **the Mill** | Doranvel (stone and flow) | the wheel | to turn | power, gearing, `bral`, the Foundry's tells | steady, dull, honest | noon |
| **the Bell** | Tantanoes (the many dusks) | the cracked bell | true time; festivals rung | the sky's words, storms, `lunae` | anxious; once repaired, exact and proud | hourly, briefly |
| **the Glass** | Lumevitre (light held) | the fallen roof | its roof; light; lenses again; a charm it approves of | foci, `vitre`, the lenses | vain, exacting, cold; keeps charms it liked | dusk |
| **the Orchard** | Saelolath (all growth beyond) | the oldest apple | seasons kept; sap given, not taken; the sluice mended | species, `sapa`, Ilvane's ward | slow, generous, wounded | afternoon |
| **the Deep** | Morithedor (cold rot in stone) | the sealed gallery | to be left alone; later, understood | Corwen's charter, `oss`, the seam's way | reluctant; frightened; not evil | never, unless spoken to |
| **the Boneyard** | Ossnem (bone named) | the warm grave | its dead named; Corwen's golems released | names of the dead, `nem`, forbidden words | grave, courteous; gives if asked rightly | midnight |
| **the Ridge** | Norael (north-all) | the far cairn | the cairns raised; the third line straight | ley, `aethe`, weather before it comes | vast, slow; speaks in weather | before storms |
| **the Moor** | many | beyond the wall | in | rot, wind, the wall's weakness, stolen names | adversarial; adaptive; bargains at cost | autumn nights |
| **the Master's echo** | Ysolde | none | to finish | fragments; in scrying margins | brief, unbidden, kind | when scrying her spells |

**Bargains** go through `voice.bargain`: an offer for a return, answered in
the spirit's verse in its channel, recorded as a spell record with the spirit
as co-caster. Spirits hold gratitude and grudges across years. **Gratitude
is visible**: the River sings when the wheel turns, carp appear, the Glass
polishes its roof. Spirits' spells scry like anyone's.

**In the machine.** Each spirit is an agent in a locked-membership channel
with a charter as a mission: wants, temper, hour, the words it holds. It acts
through the same binding with its own spell record and a standing focus for
its anchor. It writes to the news when something it cares about changes.

## 26. Golems

Bodies. Stone, wood, one of bone. Senses (its cell and neighbours; what it
carries; what it hears) and actions (move, carry, place, strike, tend, speak).

| golem | body | starts | teaches |
| --- | --- | --- | --- |
| **Toll** | stone | hauling to the fallen east tower | release; first automaton |
| **Wren** | wood | tending the hot house, caught in the quarrel | charters; the news |
| **Sedge** | wood | asleep in the reeds, unbound | reed management with the River |
| **Ash** | stone | the foundry's, unbound | wards around a charter |
| **the Warden** | stone, tall | the master's; guards the observatory; will speak | counter-working with respect |
| **Corwen's nine** | stone, one bone | in the deep, under an unread charter | the ethics of binding |

A charter is a document the player writes in verse and the familiar renders,
so a golem's mission is itself a scried spell. Chartered golems explain
themselves, badly at first. Many automata sharing corridors is year two's
coordination problem, with no scheduler provided to the player.

## 27. The Moor

The adversary. Not evil; outside. The Moor is the deep tongue said badly:
rot is what growth becomes when spoken without light. It wants in because
the chapel holds names it lost, and because the valley is attended and the
moor is not.

**Stakes stay soft.** Nothing the Moor does is permanent. It damages,
delays, and steals words; it never destroys a region, kills a golem, or takes
a name that cannot be won back. The marsh remembers, and the marsh recovers.
The player is told this early by the Hearth, so they take risks.

| year | the Moor does |
| --- | --- |
| first autumn | spore over the wall; rot in the marsh; the grate exploited |
| first winter | frost to block sluices; rot stirs Corwen's charter |
| second spring | it speaks a misfired word of yours back through a creature at the gate |
| second autumn | it bargains: a name for a name; it means it |
| third year | it adapts to wards by pattern and targets ether, not growth |
| the observatory | it must consent too |

**In the machine.** An agent with a charter, a binding scoped to the moor and
the wind, and a bounded ether budget that grows with cairn leakage. It
**learns from effects, not from reading**: it scries only what its own spells
touched and its creatures saw, never the player's verse or the familiar's
writing. Enforced by its spell record. Its spells scry like anyone's, so its
tactics can be read. It is quiet on festival nights and has never been asked
to one.

## 28. The household

Two to five apprentices sharing one valley: the trusted family or team the
workspace already assumes. Everything is shared except the familiar's
conversation, the reserve, and the spellbook, and even the spellbook can be
shelved in the chapel.

- **Rituals** need more than one voice; the observatory and the Moor's answer
  are rituals.
- **The council** is consent, not security: irreversible workings need
  another's seal.
- **Counter-working** is argument: two wards on one sluice is a conversation,
  and the River will say what it thinks.
- **Shared vocabulary**: wild words coined by one are in the others' spells;
  the chapel holds household runes and shelved verses.
- **Leaving things**: marks and charms left for each other; a lantern lit in
  the orchard for whoever comes next; a verse on the chapel shelf.
- **Presence**: the valley shows who is where; the Hearth notes who has not
  been home.
- **Festivals** are the household's; spirits judge, and the news remembers
  who won First Frost.

---

# Part VI — The campaign

Three in-world years. Goals come from the world, never from a menu.

## 29. The undone list

Beneath the letter, in Ysolde's hand, a list headed *Undone*. It is the
quest log, and it is hers: incomplete, occasionally wrong, annotated over a
decade. Items are crossed out as the estate confirms them done; the familiar
adds to it in its own hand when a spirit says what it wants; the player may
add to it. It lives in the grimoire panel. The map, the spirits' channel
headers, and the news all point at it without ever assigning anything.

The first page reads, roughly:

> the orchard — Ilvane's sluice, still. read it before you touch it
> the hot house quarrel — Wren is tired
> the wheel. ask Velharan. be literal with her
> the library — dry, not drained. the books
> the bell (silver? glass will do for a season)
> the night house — I released it. do not ask yet
> the deep — no
> the cairns
> the name

## 30. Year one: the hearth

**Spring.** The first hour (§3), then:

1. **The kitchen garden.** Cantrips; qualities by correction; the first
   misfire (moths); the sparrow scried; the vermin ward. Reward: `hara`,
   `hesk`; the first charm.
2. **The orchard flood.** Ilvane's ward: *whenever the wall stands, open the
   sluice to the orchard.* The wall fell nine hundred years ago. A notebook
   verse of Ysolde's for releasing a ward sits three pages from the letter.
   Reward: the Orchard speaks; `sapa`; Ysolde's echo in the margin.
3. **The greenhouse quarrel.** Two correct wards wrong together; Wren
   between them. Reward: Wren's charter; the news; **First Sap**, the first
   festival, small.

**Summer.** Water.

4. **The silted mill.** Not a spell; the river did it. `push`, silt, and
   Velharan's name, the first voice. Reward: the wheel drawn turning; the
   Mill speaks; power exists.
5. **The weir.** A first great working with checkpoints. Reward: sluices
   obey; the River's gratitude, visibly.
6. **The sunken library.** Dry, not drained; the books need dark. `cost`
   before committing. Reward: the Library wakes; the index, shelf by shelf.
   **Midsummer**: charms; the Glass, still under its fallen roof, judges from
   the rubble and is not satisfied.

**Autumn.** Fire, and the Moor.

7. **The cold foundry.** A compound ward; the council for fire near the
   mill. Reward: ash, salt; the Foundry speaks.
8. **First autumn.** Spore over the wall; the grate. The Moor is a code you
   can scry. Reward: the wall holds or does not; the marsh remembers.
9. **The bell.** Patched with glass for a season. Reward: true time; **First
   Frost** rung properly; the Foundry judges, loudly.

**Winter.** Reading.

10. **Frost.** Sluices freeze; the cold house needs light.
11. **The night house.** `lunae`; moon-ether; why the master released it is
    not yet said.
12. **The notebooks.** The Library reads the lineage aloud. The last notebook
    is missing its final pages. **The Long Dark**: the familiar tells the
    year's story, and mentions the observatory for the first time.

## 31. Year two: the deep and the household

**Spring.** Bodies.

13. **The upper galleries.** Toll's stale charter; then a dozen bodies, one
    cell each, hauling to the foundry with no scheduler.
14. **Sedge and the reeds.** Marsh management with the River; the grate kept
    by ecology, not force.
15. **The glassworks' roof.** Reward: the Glass speaks; foci become possible;
    it keeps a charm of yours from Midsummer, and says so.

**Summer.** Foci and runes.

16. **The staff.** Silver and glass; the Foundry and the Glass must cooperate
    and hate it.
17. **The scriptorium.** Runes taught. Writing in the old way.
18. **A word of yours.** The Moor speaks a misfired word back through a
    creature at the gate. Register; the Moor's ear.

**Autumn.** The deep.

19. **The sealed gallery.** `mira`; a name on no wall; the Deep's fear.
20. **Corwen's nine.** A four-hundred-year charter, read. The darkest hour.
    Release needs the Boneyard's names and the council's seal. Release is
    always free.
21. **The Moor bargains.** A name for a name.

**Winter.** The ridge.

22. **The cairns.** A great working per cairn, in the Ridge's weather.
23. **The third line.** Straight for the first time in centuries; it crosses
    the others at the observatory. The Ridge says why. **The Long Dark**: the
    familiar's story is about Ysolde.

## 32. Year three: the observatory

24. **The Warden.** The master's last complete spell; it will not open.
25. **Every spirit's consent.** Each want, finally met, is a seal. The Moor's
    is one of them, and the household must speak to it.
26. **The familiar's name.** In the study, at last. What happened at the
    observatory.
27. **The lenses.** Glass, silver, moon-ether, the Glass, and a ritual of the
    whole household.
28. **The master's runes.** Very good; unfinished by one line.
29. **The name.** A verse, a ritual, every seal, the moon, and the familiar
    remembering.

**The ending and the widening.** When the name is spoken, the world binding
grows a region called by that name, and it is the workspace: a ward can watch
a real channel, a golem can be bound to a real task, a scry can walk real
history, a spirit can be asked what the household has been working on. The
estate's news begins to include the workspace's. The road out opens. The game
does not end; the valley is now also a way of speaking to the thing it is
inside, and the postgame is the product. The estate's true name is a focus,
not a skeleton key: every working in the widened region uses the same spell
records and the same council, and nothing bypasses the workspace's own
authority.

---

# Part VII — Presentation

## 33. Visual language

Small, warm, hand-made. A limited palette shifting with season and hour:
spring greens and wet greys, summer gold, autumn rust and the Moor's violet,
winter blue-white with the hearth's orange the only warm thing. Tiles are
drawn, not rendered; the valley should look like a map in a notebook that
has come alive. Effects animate per tick as ink spreading. Rot is ink
bleeding the wrong way. **What is wrong is drawn wrong**: still wheels,
drowning orchards, flickering stale sigils. Gratitude is drawn too: carp,
polished glass, a singing river.

Typography carries the tone: a warm serif for the familiar and the study, a
manuscript hand for the deep tongue, each spirit with a colour and a small
ornament rather than an avatar.

## 34. Panels

- **The valley.** Region by region with an overview; layers to toggle (heat,
  water, ether, rot, light, growth, wind); flows as moving lines; the sky with
  the moon and forecast; golems and creatures moving per tick; active wards as
  faint sigils, hover to name and scry; presence of other apprentices. Pretty
  at rest, readable in trouble, and the first ten reactions visible by
  watching.
- **The grimoire.** Known words and earned entries; smudged unknowns;
  fragments; wild words with provenance; the master's index as an older
  section; the **undone list** in Ysolde's hand; active spells and their
  upkeep; foci; bargains open and settled.
- **The spellbook.** The player's own verses, named, instant to recast with
  one press, with a small before-and-after of what each did, grouped by tier
  and by region. Variations are shown as a family. Shelving a verse in the
  chapel shares it with the household. This is the artifact players
  screenshot.
- **The circle.** Spare. Verse in, one effect line out, the familiar's glance
  if you spoke prose. The fire drawn in the margin, guttering while it
  deliberates; the valley still interactive beside it.
- **The study.** Warm and typographic: the familiar, the notebooks readable
  inline with their verses marked as echoable, the lineage's stories.
- **Spirit channels.** Colour, ornament, hour; the header says what the
  spirit wants right now; quiet outside its hour, with the bell shown.
- **The chapel.** The council's cards with seals; household runes and shelved
  verses; the walls of names, readable as earned.
- **The scrying page.** §35.
- **The green.** Festivals: the household's charms side by side, the judging
  spirit's verse, the news' record of past winners.
- **The estate's news.** §36.

## 35. The scrying page

The most important screen. One readable manuscript page:

1. the verse, as spoken, with the caster and the bell hour;
2. the concepts heard, in the margin beside the words that carried them,
   uncertain ones marked; the intent record in plain words beneath;
3. the writing under the words: real code, typeset as manuscript, with the
   familiar's gloss per block in the margin and hover for plain meaning of
   any line. A player should be able to read a forty-line ward the way one
   reads a recipe before one can cook;
4. the writing's ancestry: which idiom it drew on, which spell of yours it
   varied;
5. the effects, as a list and a small before-and-after;
6. what it cost and where the ether came from;
7. what triggered it and what it triggered, as links;
8. for persistent spells, firings across time as a strip.

Scrying another's spell shows the same page in their familiar's hand.
Scrying the master's shows Ysolde's, and sometimes her echo in the margin.

## 36. The estate's news

Persistent spells, chartered golems, and spirits write to the inbox through
the alert ladder. Returning after a day away should feel like opening
letters: a page per day, in the familiar's hand, with the spirits' notes in
their colours. **Every page ends with one small thing the player can do right
now**, drawn from the undone list and the spirits' wants. Urgent things (fire
near the mill; the Moor at the grate) escalate to the top rung. Everything
acknowledges on read; nothing is guessed about whether the player saw it.

On mobile, the quickfire overlay is where the news is read and a known spell
is spoken; the valley is for the larger screen.

## 37. Sound

The hearth, the river when the weir is right, the wheel, the bell when it is
true, wind before a storm, silence in the deep, moths. Spirits have a sound
rather than a voice. Charms may make sound. Not in the first phases; the
design leaves a channel for it.

---

# Part VIII — Architecture

The rule from `agentic-architecture.md` holds throughout: deterministic code
owns state, legal transitions, resource accounting, and terminal outcomes;
agents interpret language and request narrow methods; the world
authenticates every caller and enforces the spell record.

## 38. The estate as a template

A workspace template composed over the base template, declaring the world
unit, the familiar, the spirits, the panels, the lexicon, the form gate, the
concept index, the idiom library, and the festival calendar. Estates can be
layered: a second valley, a different lineage. Notebooks, the reaction
table, the lexicon, and seed idioms are template content; cast spells,
learned idioms, inscriptions, and the spellbook live in world storage, so a
template upgrade never edits a spell the household has cast.

## 39. The world Durable Object

One `WorldDO` per valley. It owns regions (cells, flows, entities), the sky,
spell records, persistent source (wards, automata, workings, runes), the
**spell cache** (verse fingerprints → writing), the idiom library's learned
half, the lexicon's inscriptions, bargains, council cards, foci, the undone
list's state, festival records, and the news in progress.

### 39.1 The tick

One transaction:

1. collect effects submitted for this tick by evals (cantrips, charms, ward
   handlers, automata, working continuations, spirits);
2. validate each against the reaction rules, the caster's ether, and the
   spell record; reject batches that cannot pay and mark their spells
   misfired with their vivid default;
3. apply accepted effects;
4. evaluate the reaction table in order over touched regions, idle regions on
   a slower cadence;
5. advance the sky; ring the bell for festivals and storms;
6. evaluate ward triggers and enqueue handler evals;
7. run automata senses and enqueue their evals;
8. resume workings due this tick;
9. update the undone list from world state;
10. write the news;
11. emit deltas to panels and events to scrying.

### 39.2 Advancing

The world advances when it has work: a cast, a due ward, a due working, a
spirit's turn, a present player. With nobody present and nothing due, it
advances by a slow idle cadence as engine policy, so seasons pass and the
news is written. No spell can observe or depend on that cadence.

## 40. The spell cache and rehearsal forks

- **The cache** keys on a normalised verse fingerprint plus concept set plus
  subject kind. A hit returns the stored writing and intent; variations
  apply substitutions to the intent and re-rehearse cheaply without a model
  turn. Invalidation: lexicon change touching a concept, or release by the
  caster.
- **Rehearsal** forks the affected region's state into a scratch copy, runs
  the eval against it with the same binding, and discards. Forks are cheap
  because regions are bounded and rehearsal is per region. Rehearsal results
  are attached to the spell record and shown in scrying as "what it expected."

## 41. Evals and the runtime

Every cast is an eval in the caster's persistent runtime with the world
binding as a typed service. Ward handlers, automata, and continuations are
evals of stored source in the owner's runtime, scheduled by the world.
Spirits act by evals in their own runtimes. The runtime provides the sandbox,
the persistent scope, and typed services; no network is exposed to spells.
Source is stored with a content hash and its spell record; there is no
rebuild.

## 42. Enforcement

- **Form gate**: pure function; patterns in a file in the world unit.
- **Concept index**: a service; lexical first, embeddings when available.
- **Intent check**: deterministic; an intent needing concepts the record
  lacks is returned to the familiar as a mis-hearing before any eval.
- **Spell record**: minted per accepted verse; checked by every method beyond
  `read`, `adorn`, and single-cell `transmute`; caller must be the caster or a
  co-caster.
- **Rehearsal rules**: per tier, enforced by refusing to commit an
  unrehearsed ward, automaton, working, or ritual.
- **Effect ceilings**: per tier, enforced at commit.
- **Ether**: charged at commit per effect; charms free.
- **Foci and the council**: standing grants; council cards as approval
  requests sealed by named apprentices; no clock expiry.
- **The Moor's fairness**: its record limits scrying to its own effects and
  its creatures' senses; and it may not act on festival nights.
- **Soft stakes**: world rules forbid region destruction, golem death, and
  unrecoverable name theft as effects, for any caster.

## 43. Provenance and scrying

A provenance query over the trajectory (verse, intent, decision, eval), the
world's spell records and receipts, rehearsal results, idiom ancestry, and
the lexicon's inscriptions. The scrying page is a view over those walks. Deep
scrying with `mira` widens to other casters' records. The Master's echo is
content attached to her spell records, surfacing in the margin.

## 44. Channels, missions, notify

The circle and the study are two channels over one durable familiar
conversation. Spirits are agents in locked-membership channels with charters
as missions. Chartered golems are missions with the body as tool surface.
`voice.speak` publishes to the spirit's channel with the caster as addressee
ref; `bargain` opens a structured thread. The news is `notify` through the
alert ladder, acknowledge on read, with the "one thing to do now" chosen
from the undone list.

## 45. Testing

- Reaction golden tests per rule; conservation properties where they hold.
- **Readability tests**: recorded valley clips for the first ten reactions,
  reviewed by a novice without text.
- Every broken working is a fixture: state, stale source, reference verse,
  reference misfire, expected undone-list change.
- The first hour, shot by shot, as an end-to-end fixture including the
  scripted moth misfire.
- Form gate corpus: prose, verse in several languages, chants, injection,
  the notebooks.
- Concept index corpus with expected concept sets.
- The familiar bench (§22): intent, envelope, world checker, voice drift.
- Fast-path tests: a cast verse recast is instant and identical; a variation
  substitutes correctly.
- The Moor's fairness over a season.
- Soft-stakes tests: no sequence of Moor actions leaves a region
  unrecoverable.
- Household tests: five novices cannot strand the estate.

## 46. Performance

The far fen and the ridge are the largest regions; the reaction pass must
fit inside a tick budget with room for a hundred evals. Integer quantities,
region-local passes, idle regions skipped, panel deltas per tick, scrying
pages built on demand from indexes. The fast path must return within a
frame's patience; rehearsal forks must be per region, never whole-world.

---

# Part IX — Build program

Phases, each shipping a whole layer of the estate in the order the campaign
needs it, each ending with fixtures green and a household playing it. The
first hour, the fast path, the spellbook, charms, and the scrying page are in
the first phase because the loop of delight is what everything else rests on.

| phase | ships | acceptance |
| --- | --- | --- |
| **G1 The hearth** | WorldDO with all regions and the full reaction table; the sky and calendar; the form gate; lexical concept index with the starting roots; the familiar with hear, eval, reject, misfire, inscribe, remember; intent records; rehearsal forks; seed idioms; the spell cache and fast path; charms and cantrips; the circle and the study with notebook echo; the valley, grimoire, and spellbook panels; the undone list; the scrying page with glosses; the first hour scripted; the familiar bench | the first hour, shot by shot, with a novice; workings 1–3 |
| **G2 Water** | wards with rehearsal rules; the world storing source; the River, Mill, Orchard, Hearth as spirits with wants in headers; voices and bargains; sluices and the weir; great workings; the Library and the index; First Sap and Midsummer; the news with "one thing to do now" | year one spring and summer |
| **G3 Fire and the Moor** | the Foundry, the Bell, the Glass as spirits; the council and foci; crafting and reagents; the Moor with its fairness envelope and soft stakes; counter-workings; First Frost and the Long Dark; the alert ladder | year one autumn and winter |
| **G4 Bodies** | golems, automata and charters as missions, senses and actions; Toll, Wren, Sedge, Ash; the upper galleries; the glassworks; foci crafting; learned idioms promoted | year two spring |
| **G5 The old way** | runes and the scriptorium; `invoke`; ward lattices; the Moor's register and learning; `mira`; the Deep and the Boneyard; Corwen's nine; the Moor's bargain | year two summer and autumn |
| **G6 The ridge** | the Ridge; cairns under weather; the third line; the Warden; consent as seals; the familiar's arc and name | year two winter, year three spring and summer |
| **G7 The name** | the observatory; the lenses; the master's runes; the ritual; the estate's true name and the workspace as a region; the road out; the postgame under the workspace's own authority | year three autumn |
| **G8 Household and polish** | presence, shelved verses, leaving things, council challenges, rituals at scale; embeddings for the concept index; sound; mobile quickfire; season palettes; a second estate as a layered template | the whole campaign, five players |

Cross-cutting from G1: the testing program, the voice bible, the lexicon as
a living file, and playtesting with at least one person who has never seen
code.

---

# Part X — Open questions and risks

1. **Concept matching quality.** Lexical may feel stiff; embeddings may be
   too generous. The corpus decides. The margin always says what was heard.
2. **Verse in any language.** The syllable fallback must be fair to French
   and Hindi. Test with the household early.
3. **The code wall.** Glossed manuscript rendering must make a forty-line
   ward inviting. If a novice will not read a ward on the scrying page, fix
   the page before touching the rules.
4. **Fast-path fidelity.** A near-identical verse reusing writing must never
   surprise: the subject-kind and concept-set match must be strict enough
   that "quench the hearth" never reuses "quench the foundry."
5. **The familiar's cost per new cast.** Read, rehearse, write is many
   tokens. The idiom library and the fast path are the mitigation; measure
   casts per hour of play and the fraction that hit the cache.
6. **Voice drift across years.** The bible and the bench, and a review of
   the familiar's lines each phase.
7. **The Moor's fairness versus its menace.** Widen its senses through
   creatures, never its records.
8. **Tick cost at scale.** Coarsen idle cadence before shrinking regions.
9. **Generosity.** Any spell releasable, the Hearth always lights, the
   familiar always carries; a household of novices strands nothing. Tested.
10. **Binding ethics.** If Corwen's nine reads as a mechanic, revise the
    deep's writing before the rules.
11. **Festival judging.** A spirit judging charms in verse is delightful
    once and must stay so; the judging prompts need the same bench treatment
    as the familiar.
12. **The widening.** The largest surface and the demo's point. Same spell
    records, same council, nothing bypasses the workspace's authority.
13. **Time.** Nothing is a timeout. Where a design wants "after a while,"
    find the event. The bell exists for this.
