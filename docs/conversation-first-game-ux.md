# Conversation-first UX for Grimoire and Regency

## Status

Implementation plan. This document describes the intended product and
architecture; it does not change either game by itself.

## Decision summary

Both games should treat conversation as the primary way the player learns,
decides, negotiates, and acts. Their dedicated panels should become beautiful,
glanceable projections of the world rather than parallel control applications.

The governing rule is:

> Conversation drives the game; the panel shows the world.

This is not a proposal to build chat widgets inside the game panels. The games
must continue to use the workspace's canonical `panels/chat`, durable channel
participants, agent workers, inline message types, and participant methods.
The world Durable Objects remain the only source of truth. Agents may explain,
recommend, and carry a player's explicit instruction, but they never become the
authority that decides whether an action is legal or mutates state.

The target reduction is substantial:

- Grimoire: replace ten room-navigation destinations with three enduring
  surfaces: Valley, Codex, and Journal.
- Regency: remove the five-tab command application and make the strategic map,
  its contextual inspector, and a small archive the whole game panel.
- Move deterministic choices into interactive conversation cards.
- Move advice, discovery, negotiation, and narration into conversations with
  the characters who own those responsibilities.
- Keep direct manipulation only where spatial or tactile interaction is the
  point: selecting provinces, inspecting terrain, placing a charm, pointing at
  a place, or watching the world change.

## Background

### The workspace model

These games are workspace-native systems rather than conventional web games.
Each one is assembled from several independently hosted units:

- A pure engine package contains deterministic rules and domain types.
- A Durable Object worker owns authoritative game state and exposes a typed
  workspace service.
- Agent workers provide characters as ordinary workspace chat participants.
- A React panel renders a visual projection and invokes the same service
  contracts used by agents.
- `panels/chat` owns conversation history, composition, participant identity,
  inline UI, and durable channel behavior.

The important consequence is that a game panel does not need to reproduce all
of the controls of a standalone game client. Conversation is already a native,
durable, extensible application surface in the workspace.

The desired event flow is:

```text
player speaks or presses an inline decision
                  │
                  ▼
canonical workspace conversation
                  │
                  ▼
agent participant method or typed game tool
                  │
                  ▼
authoritative game Durable Object
                  │
          validates and commits
                  │
          ┌───────┴────────┐
          ▼                ▼
 updated chat card   updated visual panel
```

There must be one mutation path per action. A button in a chat card and a
button in a game panel must not evolve into two competing implementations that
need reconciliation. If an action becomes conversational, the old panel action
should be removed or reduced to a link that focuses the canonical conversation.

### Current Grimoire experience

Grimoire's fiction is inherently conversational: an apprentice speaks verse,
the familiar interprets it, spirits bargain and remember, and halls let several
spirits argue in public. The implementation already has durable channels for
the Circle, Study, spirits, golems, and halls.

The panel nevertheless asks the player to discover most of the game through
ten navigation destinations:

1. Valley
2. Circle
3. Study
4. Grimoire
5. Spellbook
6. Scrying
7. Chapel
8. Spirits
9. News
10. Green

The current React experience contains approximately 48 statically declared
buttons across the primary panel and its extracted views. Many are valid
features, but the player must infer which room contains the next meaningful
action. This makes the estate feel like an application menu instead of a place
inhabited by voices.

### Current Regency experience

Regency already has much of the required conversational foundation. The court
agent can publish durable inline cards for:

- acts awaiting the Regent's seal;
- matters of state;
- council debates;
- Lord Protector handovers; and
- season summaries.

Seal and matter cards already call the Herald's `regency.decide` participant
method, which forwards the decision to the game service and preserves the
world's identity and legality checks.

The React panel duplicates those workflows behind Realm, Seal, Council,
Realms, and Chronicle tabs. It also exposes mandate forms, diplomacy buttons,
forecast controls, season controls, and a direct JSON order editor. The result
is a strong visual map attached to a second administrative application even
though the court conversation is supposed to be where the Regency is governed.

## Product principles

### 1. A character introduces every important mechanic

The player should not need to inspect menus to discover what can happen. The
familiar, Herald, ministers, spirits, and ambassadors should surface relevant
possibilities when the world makes them meaningful.

Proactive guidance must be bounded:

- Prefer one short situation summary.
- Offer no more than three likely next actions at once.
- Do not repeat guidance the player has explicitly dismissed or acknowledged,
  or that authoritative state has resolved.
- Tie every suggestion to current authoritative state.
- Let silence and atmosphere remain part of both games.

### 2. Conversation is prose; cards are commitments

Free conversation is appropriate for questions, counsel, bargaining,
negotiation, and narration. Structured cards are appropriate when exact input
or a consequential decision must cross into the world:

- casting an exact verse;
- sealing or vetoing an act;
- choosing a matter-of-state option;
- changing a minister's mandate;
- appointing a Lord Protector;
- closing a season; or
- entering a charm in a festival.

This division keeps the experience conversational without making game
correctness depend on whether a model paraphrases an instruction accurately.

### 3. The panel is spatial and glanceable

The visual panel should answer, at a glance:

- Where am I?
- What changed?
- What needs attention?
- Who can I speak with here?

Detailed rules, ledgers, records, and choices belong in an archive or in chat.
The world view may link to them but should not permanently display them.

### 4. Progressive disclosure replaces dashboards

Show a small number of high-signal values. Reveal causal explanations and
secondary statistics on demand. Prefer one focused contextual sheet over grids
of simultaneously visible cards.

### 5. Authority remains explicit

- The game service validates every mutation.
- Agent tools stay bounded by their seat and portfolio.
- Participant methods carry exact structured actions from inline cards.
- The panel and agents use typed service clients rather than resolving or
  bypassing runtime services dynamically.
- Template installation and unit updates remain approval-gated.
- Authority manifests are reviewed as ceilings. The redesign must not reduce
  required declarations merely because fewer panel buttons remain.

## Shared target architecture

### Canonical conversation entry

Each game should have one obvious primary conversation:

- Grimoire: the apprentice's Circle conversation with the familiar.
- Regency: the Regent's court conversation.

After game creation and agent seating, the panel should open or focus that
conversation using the existing `openConversation` or `openCourt` helpers.
Those helpers already search the live panel tree and focus an existing chat
panel before opening another, so the redesign must preserve that idempotent
behavior.

The game panel should expose one persistent action—such as **Speak with the
familiar** or **Return to court**—that always focuses this conversation.

### Command principals and mutation boundaries

Moving a control into conversation does not imply that an agent Durable Object
may perform every action the panel previously performed as the user. Before
adding cards, Phase 0 must classify every mutation by its required principal:

- **Seat action:** an agent acts within its registered role and portfolio.
- **Carried Regent/apprentice action:** a narrowly authenticated participant
  carries an explicit user command from a card.
- **User-principal action:** the host invokes the game service as the
  authenticated user rather than laundering the action through an agent.
- **Spatial panel action:** an authenticated game panel directly performs the
  action because direct manipulation is the canonical interaction.

Regency currently makes this distinction deliberately. The Herald and an
empowered Lord Protector may carry seal, crisis, and season-close decisions,
but the world rejects Durable Object callers for changing a minister's
mandate, proceeding without absent courts, appointing a Lord Protector, and
dismissing one. The conversational redesign must not remove those checks or
silently treat every registered Herald call as the Regent's own hand.

For each sensitive Regency command, Phase 0 must choose one principled route:

1. Prefer a host-authenticated user-action facility, if the workspace runtime
   already exposes one suitable for inline message renderers.
2. Otherwise design a closed `carryRegentCommand` protocol whose envelope is
   authenticated to the initiating user, accepted only from the registered
   carrier, limited to an explicit command union, and replay-protected.
3. Until either route exists, retain that instrument as a user-principal panel
   action reached from conversation. This is the canonical boundary, not a
   temporary duplicate path.

Simply allowing all Durable Object callers into the existing methods is not an
acceptable implementation.

Every consequential user command also needs idempotency at the authoritative
world boundary. Cards, renderers, and participant workers may retry after a
response is lost, so deduplication in those layers is insufficient. A command
envelope contains:

```ts
interface UserCommand<TKind extends string, TPayload> {
  commandId: string;
  kind: TKind;
  payload: TPayload;
}
```

Each world owns a durable command ledger recording the command ID, operation,
bound user/player/apprentice, caller or carrier identity, canonical input
digest, status, and serialized result. The mutation and completed result must
be committed atomically. An exact replay returns the stored result; reuse of a
command ID with different input is rejected.

### Contextual speech

The player must be able to point at the visual world and then speak naturally.
Regency already implements this through `CourtVoice`, publishing province or
army context into the council channel. Generalize that interaction pattern:

- A selected province, army, Grimoire region, cell, spirit, spell, or working
  becomes a small context chip beside the conversation action.
- Opening chat carries the selected subject as structured metadata where the
  channel API supports it.
- The visible message also names the subject in prose so the conversation is
  intelligible when replayed without panel state.
- Context is ephemeral and explicit; selecting an object must never silently
  authorize an action.

### Projection-link contract

Conversation cards cannot manipulate component-local React selection state.
Before adding deep links, define one versioned, addressable contract shared by
card renderers and game panels:

```ts
type GameProjectionLink =
  | {
      version: 1;
      game: "regency";
      instance: { gameKey: string };
      surface: "map" | "archive";
      subject?: {
        kind: "province" | "army" | "event" | "law" | "promise";
        id: string;
      };
    }
  | {
      version: 1;
      game: "grimoire";
      instance: { estateKey: string; apprentice?: string };
      surface: "valley" | "codex" | "journal";
      subject?: {
        kind: "region" | "cell" | "spell" | "spirit" | "working";
        id: string;
        x?: number;
        y?: number;
      };
    };
```

A single focus-or-open operation must locate the correct panel source and game
instance, update the complete projection address through `stateArgs`, focus the
existing panel, or open one with the same address. The panel derives its active
surface and selection from this address. It must not copy the address into an
independent local state that can drift after a card focuses another subject.

If the two games do not share identical panel lookup semantics, keep separate
domain helpers over the same address schema rather than introducing an ad hoc
event bus or a weak generic abstraction.

### Durable inline message types

Cards are keyed by stable game identities and updated rather than duplicated.
The authoritative world decides card state. An agent participant publishes or
updates the card in the appropriate channel. Interactive renderers invoke a
participant method, and the game service validates the request.

Every actionable card needs:

- a stable key derived from the game object, not the render instance;
- a versioned state schema;
- a compact pill representation;
- an expanded representation;
- pending, resolved, superseded, and failed states;
- world-side command idempotency, plus idempotent participant-method handling;
- accessible labels and keyboard operation; and
- reconciliation from authoritative state after reconnect or failure.

Avoid optimistic state that can become a competing truth. A card may show a
brief local pending state, but final state comes from the world.

### Attention model and presentation ledger

Both world services should derive a small ordered attention list from game
state. This is not a new source of game logic; it is a presentation of existing
state. Each item should contain:

- stable identity;
- urgency;
- one-line explanation;
- relevant conversation/channel;
- optional world subject; and
- optional card identity.

The panel renders only the top item or an unobtrusive count. The character in
the primary conversation narrates the same items. This prevents each surface
from inventing its own definition of what matters.

Derivation alone cannot represent whether an item was already narrated or
explicitly dismissed. Each world therefore owns a durable, player-specific
presentation ledger containing at least:

- attention item key;
- player identity or Grimoire apprentice identity;
- first-surfaced world revision;
- last-narrated world revision;
- explicitly acknowledged or dismissed revision; and
- resolved revision.

“Understood” is not inferred from model behavior. An item stops repeating only
because the player explicitly acknowledged or dismissed it, the relevant
action was taken, or authoritative world state resolved it. Card publication,
panel polling, reconnect, and agent redelivery all consult the same ledger.

## Grimoire target experience

### Enduring panel surfaces

#### Valley

The Valley remains the default and visually dominant surface. Preserve:

- the illustrated hero valley;
- region selection and live thumbnails;
- the region canvas and layer inspection;
- cell focus and direct tactile adornment;
- awake spirit anchors and current wants;
- golem location and speech;
- time-of-day and seasonal animation; and
- watching the day pass.

Remove the permanent room rail. Use a restrained header or floating corner
control containing only Valley, Codex, Journal, sound, and the apprentice.

When a region, cell, spirit, golem, or working is selected, show a single
contextual sheet with:

- a concise state summary;
- the primary spatial action, if any;
- **Speak about this**; and
- **Inspect in Codex** when a record exists.

#### Codex

Combine the current Grimoire, Spellbook, Library, and Scrying destinations into
one searchable reading surface. It should support:

- words and names;
- active, shelved, and historical spells;
- idioms and learned workings;
- notebook pages and lineage stories;
- scry records and spell trails; and
- deep links from chat cards and the Valley.

The default view should be a quiet recent-items page, not four dashboards
merged together. Search and filters reveal detail progressively.

#### Journal

Combine News, Green, Chapel, household presence, and unfinished work into one
chronological estate record. Entries may contain links to a conversation or a
world subject. Consequential unresolved entries should also exist as cards in
the relevant conversation, so Journal is an archive and overview rather than a
second decision surface.

### Conversational Circle

The Circle becomes the primary familiar conversation. Add a Grimoire inline
message family with at least:

#### Verse composer

- Holds the submitted verse text and optional current world focus.
- Creates a stable command ID before the first submission and reuses it for
  uncertain retries.
- Calls a `grimoire.speak` participant method on the familiar. The participant
  method derives the apprentice from its registered seat; it never accepts an
  arbitrary apprentice identity from the renderer.
- The familiar forwards the normalized verse and command envelope to the world
  service without model-generated rewriting.
- Shows the deterministic gate result immediately.
- Becomes or links to the spell card when the world returns a spell identity.

The model may comment on or respond to the verse, but it is not responsible for
copying the verse into the game call.

The exactness boundary is the submitted request payload, not the untouched
editor buffer:

1. Normalize CRLF and bare CR line endings to LF.
2. Use `trim()` only to decide whether the input is empty; do not submit the
   trimmed value.
3. Do not apply Unicode normalization or alter leading/trailing whitespace.
4. Store the normalized submitted string unchanged in `SpellRecord.verse`.
5. Define exact equality as identical UTF-8 bytes for the submitted normalized
   payload and the stored verse.

The world binds a carried `speak` command to the registered familiar seat and
that seat's apprentice. It atomically deduplicates the command before creating
a spell, applying an instant or cached cast, or waking the familiar.

#### Spell trail

- Shows spoken, heard, looked, written, rehearsed, cast, misfired, sealed,
  fired, and promoted stages as they occur.
- Keeps prose compact by default and expands into the complete trail.
- Offers **Scry**, **Recast**, **Release**, or **Shelve** only when legal.
- Invokes participant methods whose world calls enforce the spell record,
  capability set, ether budget, and tier ceiling.
- Gives every mutating action its own stable command ID. `recast`, `release`,
  and `shelve` are deduplicated at the world boundary; retries return the stored
  result, and changed input under the same ID is rejected.

#### Scry record

- Presents source, intent, receipts, firings, uncertainty, and marginalia.
- Lives alongside the conversation that produced it.
- Deep-links to the full Codex record for extended reading.

### Study, spirits, and halls

Circle and Study have meaningfully different speech rules: the Circle hears
verse, while the Study permits ordinary questions. Do not blur those rules
behind implicit model inference.

- Keep separate durable channels for Circle and Study.
- Let the familiar explicitly offer **Step into the Study** after repeated
  prose or when the player asks to learn.
- Focus the existing Study conversation rather than rendering a Study room.
- Let notebook and story references appear as inline reading cards.

Spirits and halls should be entered from relationships, not navigation:

- Selecting an awake spirit in the Valley offers **Speak with the River**.
- The familiar may recommend a spirit when its concern matches current state.
- “Bring the Hearth and River together” produces a hall proposal card listing
  participants and topic before convening them.
- An existing hall entry in Journal focuses its durable conversation.

### Grimoire first-session journey

1. The player names the apprentice on a spare, illustrated welcome surface.
2. The familiar's Circle conversation opens beside the Valley.
3. The familiar introduces the dead hearth and publishes a verse composer.
4. The first verse changes the Valley and its trail grows in conversation.
5. The familiar briefly explains what was heard and points to the affected
   region.
6. The second working produces the scripted moth misfire, followed by a Scry
   card.
7. The player learns the Codex by following that card, not by discovering a
   navigation label.
8. Spirits, Study, halls, festivals, and the Chapel are introduced only when
   the authoritative milestones make them relevant.

## Regency target experience

### The map as the whole panel

The Regency panel should contain:

- a compact realm, season, treasury, and legitimacy strip;
- the painted strategic map;
- a contextual province or army sheet;
- subtle unresolved-matter and pending-order indicators;
- **Return to court**; and
- one archive drawer.

Remove the Realm, Seal, Council, Realms, and Chronicle tab bar.

The archive may contain laws, the complete chronicle, treaties, promises,
historical snapshots, and causal explanations. It is read-oriented. If an
archive entry needs a decision, it links to the canonical court card.

### Court as the turn interface

The Herald should organize each season in conversation:

1. Publish a compact realm briefing and identify the most important pressure.
2. Invite relevant ministers to speak rather than displaying every portfolio.
3. Let ministers stage intentions that appear immediately on the map.
4. Publish acts awaiting the seal and matters of state as actionable cards.
5. Publish a readiness card when no required decisions remain.
6. Close the season only after the Regent explicitly confirms through that
   card or tells the Herald to do so.
7. Publish the season result as a narrative digest and update the map.

Existing seal, matter, debate, handover, and season cards should be retained
and visually unified. Add the following message types:

#### Realm briefing

- One paragraph from the Herald.
- Four or fewer key figures.
- Up to three attention items.
- Links to the relevant map subjects.

#### Forecast

- Attached to an act, proposed plan, or set of pending orders.
- Shows only material deltas by default.
- Expands to treasury, legitimacy, estates, provinces, wars, and notable
  events.
- Clearly states that rival courts use steward-policy assumptions.

#### Season readiness

- Derives one explicit readiness state from phase, unresolved matters, unsealed
  acts, and rival courts.
- Reconciles readiness and legal actions from the world rather than inferring
  them independently in the renderer.

| State                 | Meaning                                                          | Legal presentation/actions                           |
| --------------------- | ---------------------------------------------------------------- | ---------------------------------------------------- |
| `blocked_by_seals`    | One or more orders still await the Regent's seal                 | Focus the relevant seal cards                        |
| `ready_with_defaults` | No seals block closure, but undecided matters will take defaults | Close season with an explicit defaults warning       |
| `ready`               | No seals or undecided matters remain                             | Close season                                         |
| `waiting_for_courts`  | The court is closed and rival sovereigns have not finished       | Continue waiting, or explicitly proceed without them |
| `finished`            | The Regency has ended                                            | No season action                                     |

**Wait** is presentation-only: it dismisses or collapses the current prompt
and does not mutate world state. **Proceed without them** is available only in
`waiting_for_courts`. The world method must enforce that `state.phase` is
`closing`; renderer eligibility alone is not an authority boundary.

#### Mandate and protector instruments

- The Regent changes a minister's mandate through a compact court instrument,
  not a seven-seat control table.
- Lord Protector appointment is a written commission card containing mandate,
  duration, and exact enforced limits.
- Dismissal and handover update the same durable thread of instruments.
- Their execution route follows the command-principal decision made in Phase 0. The existing world methods continue rejecting ordinary agent Durable
  Object callers.

#### Court directory

- Shows ministers, private chambers, ambassadors, and foreign courts.
- Focuses an existing conversation instead of opening duplicates.
- Displays standing or relationship as one restrained signal, with details on
  expansion.

### Contextual map speech

Preserve and elevate the existing “Speak about this province” behavior.

- Make it the primary action on province and army sheets.
- Let the selected subject remain visible while court is focused.
- Show staged minister intent on the map as the visual answer to conversation.
- Let event, law, promise, and chronicle cards focus the affected province.
- Keep army naming and purely spatial inspection in the contextual sheet.

### Actions to retire from the main panel

- The direct sovereign JSON order editor. It is a development escape hatch,
  not part of the Regent fantasy. If retained for diagnostics, place it behind
  an explicitly developer-oriented inspection surface outside normal play.
- Duplicate seal and veto buttons.
- Duplicate matter option buttons.
- The full council seating and mandate dashboard after initial setup.
- Diplomacy cards whose only purpose is opening a conversation.
- Permanent forecast buttons on every order.
- Permanent season-closing controls.

### Regency first-session journey

1. The player chooses the scenario and names the Regency on one illustrated
   setup surface.
2. Seating progress is shown as characters arriving, not infrastructure rows.
3. The court conversation opens automatically.
4. The Herald introduces the council and publishes the first realm briefing.
5. The player asks questions or points to a province on the map.
6. Ministers stage and argue plans; their intent appears on the map.
7. The Regent resolves cards in the conversational record.
8. A readiness card closes the season and becomes a season digest.

## Visual direction

### Shared restraint

The React rewrites established strong visual identities, but both panels still
use nested cards, repeated headings, border treatments, and control rows. The
conversation-first pass should simplify the composition before adding more
ornament.

- Give the map or Valley at least two thirds of the visual hierarchy.
- Prefer open layouts and typography over boxed sections.
- Use one elevated contextual sheet at a time.
- Reserve badges for unresolved or exceptional state.
- Keep the primary action visually unique.
- Use motion to explain world change, not to decorate idle controls.
- Preserve generous readable widths in inline cards.
- Use the games' own typefaces and palettes in card renderers without fighting
  the host chat theme.

### Responsive behavior

- Wide: world panel and canonical conversation side by side.
- Medium: world remains visible; contextual sheet overlays its edge.
- Narrow: conversation is primary, with the world available as a companion
  panel rather than a compressed dashboard.
- All essential card actions must work by keyboard and at 200% zoom.
- Reduced-motion mode must remove ornamental animation while preserving clear
  state transitions.

## Implementation plan

Implement in vertical slices. Do not maintain parallel old and new interaction
systems behind a feature flag. Each slice establishes its new canonical path,
tests it, and removes the displaced panel path in the same change.

### Phase 0 — Contract inventory and baselines

1. Enumerate every current player mutation in both panel clients.
2. Mark its future home: spatial panel action, conversation, inline card, or
   removal from normal play.
3. Record the exact game-service method, effective principal, actor identity,
   authority requirement, retry behavior, error states, and existing tests for
   each mutation.
4. Decide the command principal for Regency mandate, protector, and forced
   progress actions: host-authenticated user action, narrowly authenticated
   Regent-command carrier, or retained user-principal panel instrument.
5. Document why that route preserves the deliberate rejection of ordinary
   Durable Object callers.
6. Define the shared user-command envelope and world-owned command-ledger
   contract, including atomic result storage and input-drift rejection.
7. Define caller-to-player binding for Regency and caller-to-apprentice binding
   for Grimoire carrier commands.
8. Define `GameProjectionLink`, its `stateArgs` representation, and the exact
   focus-or-open behavior for existing and absent game panels.
9. Define the attention presentation ledger and its player-specific lifecycle.
10. Inventory all currently published Regency card schemas and keys.
11. Define versioned state schemas and participant methods for the new cards.
12. Define the Regency readiness state machine and make its server-side legal
    transitions part of the service contract.
13. Define Grimoire verse normalization and the exact stored-value boundary.
14. Capture baseline screenshots at wide, medium, narrow, dark, and light
    modes.
15. Add tests asserting current authority ceilings before moving any call
    sites.

Deliverable: an action-ownership table checked into this document or an
adjacent contract document, plus accepted command, projection-link, attention,
and readiness contracts. No UI changes yet.

### Phase 1 — Shared conversation entry and attention

1. Extract the existing focus-or-open traversal into the smallest shared
   userland helper if and only if Grimoire and Regency are truly identical.
   Otherwise retain the two domain helpers rather than creating a weak generic
   abstraction.
2. Add a stable primary-conversation action to each panel.
3. Make post-setup seating focus the canonical conversation exactly once.
4. Implement the projection-link address in panel `stateArgs` and make both
   panels restore their complete active surface and subject from it.
5. Implement the attention item type and deterministic world-state derivation.
6. Add the durable player-specific presentation ledger.
7. Render only a compact attention signal in each panel.
8. Teach the familiar and Herald briefings to narrate those same items and mark
   narration through the ledger.

Acceptance:

- Repeated conversation actions focus one existing chat panel.
- Reloading either game does not create duplicate panels or participants.
- A card can focus an exact subject in an existing or newly opened game panel.
- Attention ordering is deterministic.
- Reconnect and polling do not repeat dismissed or already narrated attention.
- No new authority path bypasses installation or capability approval.

### Phase 2 — Regency becomes court-first

Work primarily in:

- `panels/regency/App.tsx`
- `panels/regency/styles.css`
- `panels/regency/renderers/*`
- `workers/regency-agents/index.ts`
- `workers/regency-realm/*`
- `packages/regency-engine/*` only where a pure presentation derivation belongs
  in the engine

Steps:

1. Unify the visual language and state contracts of existing Regency cards.
2. Add realm briefing, forecast, readiness, mandate, protector, and directory
   cards.
3. Publish and reconcile them from stable world identities.
4. Route season closure through the already authorized Herald/Protector
   boundary with a stable command envelope and explicit user decision.
5. Route mandate changes, protector appointment/dismissal, and forced progress
   through the Phase 0 user-principal or authenticated-carrier decision. Do not
   admit general Durable Object callers to the existing world methods.
6. Implement readiness as `blocked_by_seals`, `ready_with_defaults`, `ready`,
   `waiting_for_courts`, or `finished`, with server-enforced legal actions.
7. Require `proceedWithoutPending` to be in the `closing` phase at the world
   boundary.
8. Make map selections produce contextual speech links and projection-card
   focus actions.
9. Replace the right-side tab application with one contextual inspector and an
   archive drawer.
10. Delete duplicate panel mutation controls as each card path becomes
    complete.
11. Remove the direct JSON order editor from normal play.
12. Ensure setup opens court and presents arrival as a narrative sequence.

Acceptance:

- A complete season can be played from court conversation plus optional map
  inspection.
- Every consequential action has one canonical implementation.
- Sensitive Regent-only commands preserve their effective user authority.
- Retrying a committed card action returns its stored result without repeating
  effects.
- The panel has no primary tab bar.
- The map remains useful while court is open beside it.
- Card actions survive reload, replay, reconnect, and duplicate delivery.

### Phase 3 — Grimoire learns to converse

Work primarily in:

- `panels/grimoire/App.tsx`
- `panels/grimoire/styles.css`
- new `panels/grimoire/renderers/*`
- `panels/grimoire/lib/estate.ts`
- `workers/grimoire-agents/index.ts`
- `workers/grimoire-world/*`
- `packages/grimoire-engine/*` for pure card/attention derivations

Steps:

1. Define Grimoire message types for the verse composer, spell trail, scry
   record, notebook/story reading, hall proposal, Chapel matter, and festival
   entry.
2. Add the familiar participant methods required by those cards.
3. Bind each carried command to the registered familiar seat and derive its
   apprentice from that seat rather than card input.
4. Add the world-owned command ledger and atomically deduplicate `speak`,
   `recast`, `release`, and `shelve` at their mutation boundary.
5. Apply the documented line-ending normalization, preserve the submitted
   string otherwise, and do not route verse text through model-generated
   output.
6. Publish one stable spell card per spell and update its trail from world
   state.
7. Connect Scry and Codex projection links to the same spell identity.
8. Make repeated prose offer the separate Study conversation.
9. Move spirit and hall entry to contextual world relationships.
10. Publish unresolved Chapel and festival choices into conversation while
    retaining Journal as their archive.
11. Make the first-hour sequence teach these surfaces through character turns.

Acceptance:

- The first two spells, including the scripted misfire and Scry suggestion,
  can be completed without using room navigation.
- The normalized submitted payload and stored spell verse have identical UTF-8
  bytes; editor whitespace and Unicode are otherwise preserved.
- Retry after commit but before response returns the original spell and result
  without applying another consequence.
- A familiar cannot submit a command for another apprentice.
- A player can reach Study, a spirit, and a hall through conversation or world
  context.
- Cards never let the familiar exceed world-enforced spell authority.

### Phase 4 — Consolidate the Grimoire panel

1. Introduce Valley, Codex, and Journal as the only enduring panel surfaces.
2. Merge existing reading views into a searchable Codex information
   architecture.
3. Merge News, Green, Chapel, household, and unfinished work into Journal.
4. Remove the ten-room rail and the displaced room components.
5. Preserve direct region exploration, adornment, and time visualization.
6. Default obsolete or absent `view` state to Valley. Do not build a permanent
   compatibility router for old room names; either retain a value because it
   remains part of the new model or remove it deliberately.

Acceptance:

- The panel exposes no more than three top-level destinations.
- No feature depends on guessing which old room contains it.
- Codex and Journal support stable deep links from chat and the Valley.
- The Valley remains the visual center of the experience.

### Phase 5 — Reduction and beauty pass

Only after the interaction paths are canonical:

1. Remove unused CSS, components, service calls, and duplicated polling.
2. Replace nested cards with typography, spacing, and one contextual layer.
3. Tune wide, medium, and narrow layouts using real hosted panels.
4. Align inline cards with each game's visual language.
5. Add purposeful transitions for world updates and card resolution.
6. Verify reduced motion, keyboard order, focus restoration, contrast, zoom,
   screen-reader labels, and touch targets.
7. Re-record screenshots and compare them to the Phase 0 baselines.

## Testing strategy

### Pure and worker tests

- Attention derivation is deterministic and stable under replay.
- Attention narration and dismissal are durable and scoped to the correct
  player or apprentice.
- Card state derives from world state and stable keys.
- Participant methods reject missing, stale, foreign, or illegal identities.
- The registered carrier cannot act for another game, player, apprentice, or
  role.
- Repeating the same command ID and input returns the stored result without
  repeating effects.
- Reusing a command ID with different input is rejected.
- Retry after commit but before response is safe for `speak`, `recast`,
  `release`, `shelve`, season closure, and every new Regent instrument.
- Verse submission normalizes only line endings and preserves the remaining
  submitted content exactly.
- Season readiness covers seals, defaulted matters, phase, pending courts, and
  finished games as explicit states.
- `proceedWithoutPending` is rejected outside the closing phase.
- Ordinary Durable Object callers remain unable to change mandates, appoint or
  dismiss a Protector, or force progress.

### Renderer tests

- Every message type renders pill and expanded modes.
- Pending and resolved states are distinguishable without color alone.
- Actions disable while pending and reconcile after authoritative refresh.
- Failed participant calls remain retryable and do not claim success.
- Deep links target the correct game, conversation, and object identity.

### Panel tests

- Top-level destinations match the reduced information architecture.
- Conversation actions focus existing panels before opening new ones.
- Spatial selections can be spoken about and inspected.
- Projection links restore the requested game instance, surface, and subject
  after reload and when opening a new panel.
- No removed panel action remains as a hidden duplicate.
- Authority manifest expectations remain exact.

### Hosted system verification

Use an isolated managed instance created from the combined Base and Examples
checkout. Verify:

- first-run setup and installation-review prompts;
- both game panels at real hosted viewport sizes;
- chat card publication, interaction, reconciliation, and replay;
- retry after a committed mutation whose first response is deliberately lost;
- rejection of a carried command with a mismatched player or apprentice;
- cross-panel projection links from chat into existing and absent game panels;
- attention dismissal followed by reload and reconnect;
- a complete Grimoire first-hour sequence;
- a complete Regency season;
- reload and reconnect during a pending decision;
- light, dark, narrow, and reduced-motion presentations; and
- cleanup of the exact owned instance and panel connections.

## Completion criteria

The redesign is complete when:

- Conversation is the obvious next step after setup in both games.
- Grimoire has at most three enduring panel destinations.
- Regency has no primary administrative tab bar.
- A player can complete Grimoire's first-hour arc without searching menus.
- A player can complete a Regency season from court conversation, using the
  map only for spatial understanding and pointing.
- All consequential chat actions are structured, authoritative, idempotent,
  and recoverable.
- Sensitive Regent commands preserve the user/carrier boundary selected in
  Phase 0; general agent Durable Objects do not inherit Regent authority.
- Grimoire commands are bound to the registered familiar and apprentice and
  are deduplicated by the world.
- Chat cards can address exact game-panel projections without an event bus or
  panel-specific side channel.
- Attention guidance has durable, player-specific acknowledgment and narration
  state.
- Regency readiness is an explicit server-enforced state machine.
- No game mutation exists as divergent panel and conversation implementations.
- Agents proactively explain relevant state without flooding the channel.
- The maps are visually dominant and meaningfully calmer.
- Existing service boundaries and authority ceilings remain explicit and are
  covered by tests.
- Both games pass focused engine, worker, panel, and hosted lifecycle checks.

## Suggested commit sequence

Keep changes reviewable and vertically complete:

1. `docs(games): define conversational action ownership`
2. `feat(regency): publish the season through court cards`
3. `refactor(regency): reduce the panel to map and archive`
4. `feat(grimoire): carry exact verse through conversation`
5. `feat(grimoire): publish spell and estate cards`
6. `refactor(grimoire): consolidate the estate into three surfaces`
7. `style(games): quiet the world panels and unify conversation cards`
8. `test(games): verify conversation-first hosted journeys`

Each implementation commit should include the removal of the UI path it
supersedes. Temporary duplicate paths, compatibility flags, and panel-local
chat substitutes are explicitly outside this plan.
