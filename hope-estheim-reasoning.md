# Hope Estheim builds — how the decisions were made

Companion to `hope-estheim-bracket-3.md`. This explains the method, what was verified, what was estimated, and why each major card choice was made.

## 1. Order of work

1. Read the repo first. The app embeds your physical library (993 entries, 30 flagged as proxies) and 18 deck files that carry Scryfall oracle text for every card in those decks. That gave me a reliable list of what you already own, where it lives, and which decks belong to other people (Riders of Rohan and Silverquill Influence are tagged as your sister's and her boyfriend's, so they were excluded as sources).
2. Verify the commander. Hope Estheim: {W}{U}, Legendary Creature — Human Wizard, 2/2, lifelink, "At the beginning of your end step, each opponent mills X cards, where X is the amount of life you gained this turn." Confirmed via Scryfall and Gatherer search snippets. Two consequences drive every later choice: only life gained on **your** turn counts, and X is counted once on resolution, so a single big gain in your end step is as good as many small ones.
3. Verify the rules boundary. Bracket 3 after the October 2025 revision and the February 2026 list: up to 3 Game Changers, no mass land denial, no chained extra turns, games expected to end turn 6 or later, tutors unrestricted. The full white and blue Game Changer lists were cross-checked against three independent list pages because they disagreed on history but agreed on the current contents.
4. Collect card-pool knowledge: EDHREC's Hope Estheim pages (lifegain, upgraded, cEDH, combo tags), the EDHREC build article, Draftsim's guide, and Commander Spellbook for the Heliod + Walking Ballista combo. Final Fantasy cards I did not know well (The Wind Crystal, Adventurer's Inn) were checked individually. Delney's ruling was checked to confirm it doubles Hope's trigger.
5. Price the buy list from TCGplayer and MTGStocks snippets. Anything I could not find is marked "est." in the deck file.
6. Build two lists, validate them with a script (99 cards, no duplicates, 3 Game Changers each), then write everything up.

## 2. Constraints I could not remove

- Scryfall, EDHREC, Moxfield, Archidekt and Commander Spellbook are blocked by this session's network policy. I could search the web but not open those sites. Card text for cards already in your decks came from the cached Scryfall data in the repo. Text for cards you do not own came from search snippets or from memory where the card is old and well known (Soul Warden, Traumatize, Beacon of Immortality, and so on).
- Because of that, I could not generate a deck JSON for your app. The decklists are in Moxfield paste format instead, which the app accepts.

## 3. Why two different shapes

You asked for two powerful options and a deck that makes the table miserable. Those two goals pull in different directions, so I split them:

- **Option 1** keeps Hope as the engine. It is the "commander matters" build. It is faster and has a real combo.
- **Option 2** treats Hope as a cheap lifelink body and makes the table-hostile elements the deck's identity: prison pieces, counters, taxes, and a wheel-into-mill finish. It is the stronger deck against a tuned pod but Hope is a supporting piece.

Presenting one lifegain-mill list and one slightly tweaked variant would not have been a real choice.

## 4. Game Changer allocation

Three slots per deck. I picked the three with the highest impact per slot for each plan:

- **Rhystic Study** in both. Best draw engine in the colours and a tax that fits the theme.
- **Smothering Tithe** in both. You already own a proxy, it is the strongest ramp enchantment in white, and it taxes draws.
- **Cyclonic Rift** in Option 1. A creature-based engine deck needs one card that resets a lost board.
- **Drannith Magistrate** in Option 2. The single most hostile permanent in white at 2 mana, and the prison plan is built around it.

Rejected: Teferi's Protection (you own two, but it is a Game Changer and defensive only), Fierce Guardianship and Force of Will (free counters push the feel toward Bracket 4 and would need slots taken from Rhystic or Tithe), Mana Vault / Grim Monolith / Chrome Mox / Ancient Tomb / The One Ring (you own them in Vivi and Sauron, but fast mana is the single biggest Bracket 4 signal), Narset (would have been ideal with Windfall in Option 2, but it is on the list and the fourth slot does not exist).

## 5. Key card decisions, Option 1

- **Soul Warden, Soul's Attendant, Suture Priest, Lunarch Veteran, Auriok Champion, Daxos**: cheap, redundant, trigger on your own turn when you make tokens. Six copies of the same effect is the point.
- **Delney, Streetwise Lookout**: doubles Hope's end-step trigger and every sister trigger. Expensive (34 to 37 USD) but it is the best card in the deck after Bruvac.
- **Bruvac the Grandiloquent**: doubles all mill. Also turns kicked Maddening Cacophony into a full library.
- **Fraying Sanity**: cheap, lets you pick the player who dies first.
- **The Wind Crystal, Rhox Faithmender, Boon Reflection, Alhammarret's Archive**: life doublers stack multiplicatively. With two of them a Beacon of Immortality at 40 life is 160 life gained and 160 cards milled per opponent before Bruvac.
- **Heliod, Sun-Crowned + Walking Ballista**: the only infinite. Idyllic Tutor can find Heliod but nothing in the deck finds Ballista, so it stays a natural-draw combo and does not pull the deck toward consistent early wins.
- **Felidar Sovereign, Approach of the Second Sun**: alternate wins that force answers. Felidar is the one some pods dislike. Cut it for Serra Ascendant or Archangel of Thune if your table complains.
- **Fumigate over Day of Judgment**: same wrath, gains life on your turn.
- **Secure the Wastes, Martial Coup**: instant-speed or wrath-attached token makers that re-trigger the sisters after a board wipe.

## 6. Key card decisions, Option 2

- **Drannith, Lavinia, Archon of Emeria, Aven Mindcensor, Thalia Heretic Cathar, Linvala Keeper of Silence, Grand Abolisher**: each shuts off a different thing (commanders, free spells, spell count, tutors, haste and untapped lands, activated abilities, your own turn). Together they cover most of what a Bracket 3 opponent is trying to do.
- **Ghostly Prison, Propaganda, Sphere of Safety**: you have few creatures, so attacks have to be taxed instead of blocked.
- **Teferi's Tutelage, Psychic Corrosion**: each card you draw mills every opponent. Teferi's Ageless Insight and Alhammarret's Archive double your draws, Bruvac doubles the mill.
- **Windfall, Jace's Archivist**: wheels that do not shuffle graveyards back into libraries. Timetwister-style effects (Commit // Memory, Echo of Eons, Day's Undoing) were rejected because they refill the libraries you just emptied.
- **Traumatize, Fractured Sanity, Maddening Cacophony**: direct mill to finish, and to answer a player holding a shuffle-back effect.
- **Memory Lapse**: a counter that puts the spell back on top so the next draw trigger mills it again.
- **Supreme Verdict**: on the buy list because your only copy is in your sister's deck.
- **Why no Rule of Law or Deafening Silence**: they would stop the deck's own counterspells and wheels.
- **Why no Winter Orb / Static Orb / Stasis**: those are the cards the mass-land-denial rule is written about.

## 7. Mana base

21 nonbasics plus basics, 35 total, with 8 or 9 rocks. The commander costs 2 so the curve is low, but Archive, Rhystic and Tithe reward hitting land drops through turn 6. Everything but Hallowed Fountain, Deserted Beach, Castle Ardenvale, Adventurer's Inn, Radiant Fountain and Reliquary Tower is already in your decks. Mistrise Village was dropped because it always enters tapped in Azorius. Port Town and Windbrisk Heights were skipped because they are in your sister's deck.

## 8. How the power-level claims were reached

- **Turn-to-kill estimates** come from the mana curve and the number of pieces needed: Option 1 needs Hope plus one doubler plus one big gain (Beacon, Revelation, or a lifelink alpha with Akroma's Will) and lands that around turn 7 to 9 on average. Option 2 needs a draw engine, a mill enchantment and a wheel, which is three pieces, so turn 8 to 10.
- **Bracket placement** is based on the rule text, not on feel: 3 Game Changers, no land denial, no extra turns, no fast mana, one non-tutorable infinite in Option 1 and none in Option 2. That is a Bracket 3 deck by definition. Both would be Bracket 4 the moment you add Mana Vault, Grim Monolith, Fierce Guardianship or Force of Will from Vivi.
- **Interaction counts** (6 to 7 counters, 3 spot removal, 4 wraths) were counted from the lists.
- **Weak points** come from the mechanics: mill loses to library shuffles (Elixir of Immortality, Gaea's Blessing, the Eldrazi titans), the commander is a 2/2, and Option 2's Archon of Emeria limits you as well.

## 9. What was estimated, not verified

- Prices marked "est." in the deck file (about 20 cheap cards, plus Auriok Champion, The Wind Crystal, Grand Abolisher's exact figure, Teferi Hero of Dominaria, Linvala, Supreme Verdict).
- Oracle text for cards not in your decks and not individually searched. These are all long-printed, widely played cards where I am confident of the text, but none of them were re-read from Scryfall in this session.
- CAD conversions use roughly 1.38 to match the ratio in your app's buy lists.

If you allow api.scryfall.com in the environment's network settings, I can re-verify every line and produce the deck JSON for the app.
