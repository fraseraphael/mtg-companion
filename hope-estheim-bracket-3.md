# Hope Estheim — two Bracket 3 builds

Commander: **Hope Estheim** {W}{U} · Legendary Creature — Human Wizard · 2/2 · Lifelink.
"At the beginning of your end step, each opponent mills X cards, where X is the amount of life you gained this turn."
Ruling: X is counted once, when the trigger resolves. Only life gained **on your own turn** feeds the mill.

Both lists below are exactly 99 cards, Azorius identity, Commander legal, and stay inside the Bracket 3 ("Upgraded") rules as of the February 2026 update:
- Max 3 Game Changers. Both builds use exactly 3.
- No mass land denial. Neither build runs any.
- No chained extra turns. Neither build runs extra turns at all.
- Infinite combos are allowed but should not win before roughly turn 6. Option 1 has one natural two-card infinite (Heliod + Walking Ballista) with no tutor for it. Option 2 has no infinite at all.

Ownership notes are based on the library and the 18 deck files in your repo. "Sister" decks (Riders of Rohan, Silverquill Influence) were left alone.

---

## Option 1 — "The Hospital" (Lifegain engine, Delney, Heliod/Ballista)

**Game Changers (3):** Rhystic Study, Smothering Tithe, Cyclonic Rift.

**Plan.** Cheap lifegain creatures (Soul Warden, Soul's Attendant, Suture Priest, Lunarch Veteran, Auriok Champion, Daxos) turn every creature that enters into life. Life doublers (The Wind Crystal, Rhox Faithmender, Boon Reflection, Alhammarret's Archive) multiply it. Draw engines (Well of Lost Dreams, Dawn of Hope, Archive, Rhystic) turn the life into cards. Hope converts the life into mill every end step, Bruvac doubles the mill, Fraying Sanity doubles it on the player you want dead first, and Delney makes Hope trigger twice.

**Kill lines.**
1. **Beacon of Immortality** on yourself at 40+ life: gain 40+. With Hope out that is 40+ cards milled per opponent at end step. With Bruvac that is 80+. With Delney it fires twice. One spell, table dead on their next draw.
2. **Heliod, Sun-Crowned + Walking Ballista** (Ballista with 2+ counters): infinite damage and infinite life. Commander Spellbook lists this as a 2-card, 5-step combo.
3. **Maddening Cacophony (kicked) + Bruvac**: each opponent mills their whole library.
4. **Felidar Sovereign / Approach of the Second Sun**: "fuck you" backup wins that force answers.
5. Fair plan: Serra-style lifelink beats, Resplendent Angel tokens, Secure the Wastes / Martial Coup with the sisters out, and Fumigate as a wrath that also gains 1 life per creature.

### Decklist (paste into Moxfield / your app)
```
1 Hope Estheim

1 Soul Warden
1 Soul's Attendant
1 Suture Priest
1 Lunarch Veteran
1 Auriok Champion
1 Daxos, Blessed by the Sun
1 Speaker of the Heavens
1 Angel of Vitality
1 Righteous Valkyrie
1 Resplendent Angel
1 Voice of the Blessed
1 Delney, Streetwise Lookout
1 Heliod, Sun-Crowned
1 Walking Ballista
1 Bruvac the Grandiloquent
1 Mentor of the Meek
1 Welcoming Vampire
1 Faerie Mastermind
1 Rhox Faithmender
1 Felidar Sovereign

1 The Wind Crystal
1 Alhammarret's Archive
1 Well of Lost Dreams
1 Dawn of Hope
1 Rhystic Study
1 Mystic Remora
1 Smothering Tithe
1 Authority of the Consuls
1 Blind Obedience
1 Fraying Sanity
1 Boon Reflection
1 Lightning Greaves

1 Sol Ring
1 Arcane Signet
1 Azorius Signet
1 Talisman of Progress
1 Mind Stone
1 Fellwar Stone
1 Pristine Talisman
1 Marble Diamond
1 Wayfarer's Bauble

1 Swords to Plowshares
1 Path to Exile
1 Generous Gift
1 Counterspell
1 Mana Drain
1 Swan Song
1 Arcane Denial
1 Dovin's Veto
1 An Offer You Can't Refuse
1 Flawless Maneuver
1 Akroma's Will
1 Cyclonic Rift
1 Beacon of Immortality
1 Sphinx's Revelation
1 Secure the Wastes
1 Martial Coup
1 Fumigate
1 Sunfall
1 Austere Command
1 Maddening Cacophony
1 Approach of the Second Sun
1 Fact or Fiction
1 Idyllic Tutor

1 Command Tower
1 Hallowed Fountain
1 Deserted Beach
1 Glacial Fortress
1 Prairie Stream
1 Turbulent Shore
1 Seachrome Coast
1 Adarkar Wastes
1 Mystic Gate
1 Skycloud Expanse
1 Temple of Enlightenment
1 Restless Anchorage
1 Path of Ancestry
1 Otawara, Soaring City
1 Minamo, School at Water's Edge
1 Castle Ardenvale
1 Adventurer's Inn
1 Radiant Fountain
1 Reliquary Tower
1 Ash Barrens
1 Thriving Isle
8 Plains
6 Island
```

### Why this is Bracket 3 and not 2 or 4
- **Speed.** Goldfish kill is turn 7 to 9. Hope on turn 2, sisters on 1 to 3, the first real mill turn is 4 to 5 (10 to 20 cards per opponent with one doubler), the Beacon or Cacophony kill lands turn 7 to 9 with Bruvac. That matches the "turn 6 or later" expectation of Bracket 3. There is no fast mana beyond Sol Ring, no free counters, and only Idyllic Tutor, which finds Heliod but never Ballista, so it does not hit the turn 4 to 5 kills Bracket 4 decks are built for.
- **Consistency.** 13 lifegain enablers, 4 life multipliers, 3 mill multipliers, 8 draw engines. You will have an engine online by turn 4 in most games. Redundancy is what pushes it above a Bracket 2 precon.
- **Interaction.** 6 counters, 3 spot removal, 4 wraths, 1 Rift. That is a real control suite. Bracket 2 decks run half that.
- **Resilience.** Flawless Maneuver, Akroma's Will, Greaves, Fumigate (gains life while wiping), and a commander that costs 2 to recast. Wraths hurt the sisters, so hold Secure the Wastes / Martial Coup to rebuild after.
- **Weak points.** Rest in Peace or Leyline of the Void do nothing against mill-out (milled cards exiled still leave the library), but Elixir of Immortality style shuffles and Gaea's Blessing do. Hope is a 2/2 and will eat removal every game. Delney and Bruvac are the two cards opponents must kill on sight.
- **The "fuck you" factor.** Beacon for 40+ at instant speed in your end step is the single rudest play available to this commander. Smothering Tithe, Rhystic Study and Authority of the Consuls make the table pay for everything. Felidar Sovereign at 40 starting life is a must-answer that wins on your upkeep.

### Already owned (where it lives)
| Card | Deck |
|---|---|
| Rhystic Study, Faerie Mastermind, Mystic Remora | Vivi Ornitier (Bracket 4) |
| Cyclonic Rift | Vivi / Sauron / Explorers of the Deep (3 copies) |
| Counterspell, Mana Drain, Arcane Denial, Fact or Fiction | Sauron, the Dark Lord |
| Swan Song | Elven Council |
| Smothering Tithe (proxy), Akroma's Will (proxy), Lightning Greaves (proxy), Swords (proxy), Path (proxy), Welcoming Vampire, Generous Gift, Austere Command | The Company |
| Well of Lost Dreams, Dawn of Hope, Mentor of the Meek, Fumigate, Pristine Talisman | Food and Fellowship |
| Speaker of the Heavens, Angel of Vitality, Righteous Valkyrie, Marble Diamond | Calling All Angels |
| Azorius Signet, Talisman of Progress, Secure the Wastes, Martial Coup, Sunfall, Glacial Fortress, Prairie Stream, Turbulent Shore, Mystic Gate, Restless Anchorage, Flawless Maneuver | Multiverse Reforged |
| Adarkar Wastes, Seachrome Coast, Skycloud Expanse, Temple of Enlightenment, Thriving Isle, An Offer You Can't Refuse, Mind Stone, Fellwar Stone | Peace Offering |
| Otawara, Minamo | Vivi Ornitier |
| Sol Ring, Arcane Signet, Command Tower, Path of Ancestry, Wayfarer's Bauble, Ash Barrens, basics | many decks / binder |

### Buy list (USD, TCGplayer market where found, Oct 2026; "est." = my estimate, check before ordering)
| Card | Price |
|---|---|
| Bruvac the Grandiloquent | 42 to 45 |
| Delney, Streetwise Lookout | 34 to 37 |
| Heliod, Sun-Crowned | 21 to 22 |
| Beacon of Immortality | 14 |
| Auriok Champion | 10 to 13 est. |
| Boon Reflection | 11.5 |
| Resplendent Angel | 9 to 11 |
| Walking Ballista | 10 |
| Alhammarret's Archive | 10 |
| Maddening Cacophony | 8 to 11 |
| Hallowed Fountain | 8 to 10 |
| Blind Obedience | 7 to 9 |
| The Wind Crystal | 4 to 6 est. |
| Felidar Sovereign | 4.5 |
| Authority of the Consuls | 3.7 |
| Soul Warden | 3 to 5 |
| Approach of the Second Sun | 3 est. |
| Voice of the Blessed | 3 est. |
| Suture Priest | 2.5 |
| Soul's Attendant | 2 est. |
| Rhox Faithmender | 2 |
| Deserted Beach | 2 |
| Fraying Sanity, Sphinx's Revelation, Dovin's Veto, Idyllic Tutor, Reliquary Tower, Daxos, Lunarch Veteran, Castle Ardenvale, Adventurer's Inn, Radiant Fountain, Hope Estheim | about 1 to 2 each or less |
| **Total** | **about 235 USD (roughly 325 CAD)** |

Optional upgrades if you want to spend more: Archangel of Thune (45 to 65), Serra Ascendant (30, a 6/6 lifelink flyer on turn 1 at 40 life), Esper Sentinel (53 to 61), Teferi's Protection (you own two; it is a Game Changer, so one would have to replace Rift or Tithe).

---

## Option 2 — "The Tax Office" (Prison, counters, wheel-mill)

**Game Changers (3):** Rhystic Study, Smothering Tithe, Drannith Magistrate.

**Plan.** Lock the table out of doing anything cheaply: Drannith stops commanders being cast, Lavinia stops free spells and cheating, Archon of Emeria makes everyone one-spell-per-turn and taps their nonbasics, Aven Mindcensor shuts off tutors and fetches, Thalia makes their stuff enter tapped, Linvala turns off activated abilities, Ghostly Prison / Propaganda / Sphere of Safety make attacking you cost 2 to 8 per creature, Grand Abolisher makes your turn untouchable. Rhystic, Tithe, Remora and Blind Obedience tax every spell. Then you mill them through card draw: Teferi's Tutelage and Psychic Corrosion mill 2 each per card you draw, Teferi's Ageless Insight and Alhammarret's Archive double your draws, Bruvac doubles the mill. Windfall and Jace's Archivist are repeatable wheels. Hope adds a lifelink wall that mills a few more each turn and sets up the Beacon finish.

**Kill lines.**
1. **Windfall / Jace's Archivist with Tutelage + Corrosion + Bruvac**: every card you draw mills each opponent 8. A 7-card wheel is 56 per opponent. Two activations ends the game.
2. **Traumatize or kicked Maddening Cacophony + Bruvac**: whole library.
3. **Beacon of Immortality / Sphinx's Revelation** into Hope's end step as in Option 1.
4. **Approach of the Second Sun** behind a wall of counters.

### Decklist
```
1 Hope Estheim

1 Drannith Magistrate
1 Lavinia, Azorius Renegade
1 Archon of Emeria
1 Aven Mindcensor
1 Grand Abolisher
1 Thalia, Heretic Cathar
1 Linvala, Keeper of Silence
1 Soul Warden
1 Suture Priest
1 Bruvac the Grandiloquent
1 Jace's Archivist
1 Faerie Mastermind
1 Spellseeker
1 Archivist of Oghma
1 Rhox Faithmender

1 Rhystic Study
1 Smothering Tithe
1 Mystic Remora
1 Authority of the Consuls
1 Blind Obedience
1 Ghostly Prison
1 Propaganda
1 Sphere of Safety
1 Teferi's Tutelage
1 Psychic Corrosion
1 Fraying Sanity
1 Alhammarret's Archive
1 Teferi's Ageless Insight
1 Lightning Greaves
1 Grasp of Fate

1 Teferi, Time Raveler
1 Teferi, Hero of Dominaria

1 Sol Ring
1 Arcane Signet
1 Azorius Signet
1 Talisman of Progress
1 Mind Stone
1 Fellwar Stone
1 Pristine Talisman
1 Thought Vessel

1 Swords to Plowshares
1 Path to Exile
1 Generous Gift
1 Counterspell
1 Mana Drain
1 Swan Song
1 Arcane Denial
1 Dovin's Veto
1 An Offer You Can't Refuse
1 Memory Lapse
1 Flawless Maneuver
1 Clever Concealment
1 Windfall
1 Maddening Cacophony
1 Fractured Sanity
1 Traumatize
1 Sphinx's Revelation
1 Beacon of Immortality
1 Blue Sun's Zenith
1 Fact or Fiction
1 Approach of the Second Sun
1 Sunfall
1 Austere Command
1 Supreme Verdict

1 Command Tower
1 Hallowed Fountain
1 Deserted Beach
1 Glacial Fortress
1 Prairie Stream
1 Turbulent Shore
1 Seachrome Coast
1 Adarkar Wastes
1 Mystic Gate
1 Skycloud Expanse
1 Temple of Enlightenment
1 Restless Anchorage
1 Path of Ancestry
1 Otawara, Soaring City
1 Minamo, School at Water's Edge
1 Castle Ardenvale
1 Adventurer's Inn
1 Radiant Fountain
1 Reliquary Tower
1 Ash Barrens
1 Thriving Isle
6 Plains
8 Island
```

### Why this is Bracket 3 and not 2 or 4
- **Speed.** Slower to kill than Option 1: realistic win turn 8 to 10. It wins by making the game unplayable for everyone else first, then milling. No infinite combos at all, so it cannot accidentally break the Bracket 3 turn-6 expectation.
- **Consistency.** 9 tax or lock pieces, 7 counters, 4 wraths, 6 mill multipliers or payoffs, 5 draw doublers or engines. Almost every opening hand has a lock piece plus a draw engine.
- **Interaction.** The densest interaction suite you can run in Bracket 3 without going to free counters (Fierce Guardianship and Force of Will are Game Changers and would push it to 5).
- **Resilience.** Teferi, Time Raveler and Grand Abolisher make your turns safe. Supreme Verdict cannot be countered. Grasp of Fate exiles one thing per opponent.
- **Weak points.** It taxes itself a bit: Archon of Emeria limits you to one spell per turn too, so play him once your rocks are down. Low raw lifegain, so Hope mills 3 to 6 per turn, not 20. Pods that run graveyard shuffle effects (Elixir, Gaea's Blessing, Kozilek/Ulamog) blank the mill plan; keep Traumatize for the player with a shuffle piece and point Fraying Sanity elsewhere.
- **The "fuck you" factor.** Highest of the two. Drannith plus Archon plus Lavinia plus pillow fort is the deck people complain about. Declare "Bracket 3, stax-leaning" before the game or you will get a bad table.

### Already owned (where it lives)
Same as Option 1 for the mana base, rocks, counters and removal, plus: Spellseeker and Windfall (Vivi), Thought Vessel (Peace Offering), Clever Concealment (The Company, proxy), Grasp of Fate (Calling All Angels).
Supreme Verdict is in Riders of Rohan (your sister's deck), so it is on the buy list.

### Buy list (USD)
| Card | Price |
|---|---|
| Bruvac the Grandiloquent | 42 to 45 |
| Grand Abolisher | 16 to 22 |
| Beacon of Immortality | 14 |
| Drannith Magistrate | 12 to 14 |
| Alhammarret's Archive | 10 |
| Maddening Cacophony | 8 to 11 |
| Hallowed Fountain | 8 to 10 |
| Blind Obedience | 7 to 9 |
| Psychic Corrosion | 6 to 9 |
| Teferi, Time Raveler | 7 |
| Teferi, Hero of Dominaria | 5 to 8 est. |
| Supreme Verdict | 4 to 6 est. |
| Soul Warden | 3 to 5 |
| Teferi's Ageless Insight | 3 to 5 est. |
| Linvala, Keeper of Silence | 3 to 5 est. |
| Authority of the Consuls | 3.7 |
| Propaganda | 3 to 4 est. |
| Archon of Emeria | 3 |
| Traumatize | 3 est. |
| Approach of the Second Sun | 3 est. |
| Sphere of Safety | 3 est. |
| Fractured Sanity | 2 to 3 est. |
| Ghostly Prison | 2 to 3 est. |
| Jace's Archivist | 2 to 3 est. |
| Archivist of Oghma | 2 to 3 est. |
| Suture Priest | 2.5 |
| Rhox Faithmender | 2 |
| Thalia, Heretic Cathar | 2 |
| Deserted Beach | 2 |
| Aven Mindcensor, Lavinia, Blue Sun's Zenith, Teferi's Tutelage, Fraying Sanity, Sphinx's Revelation, Dovin's Veto, Memory Lapse, Reliquary Tower, Castle Ardenvale, Adventurer's Inn, Radiant Fountain, Hope Estheim | about 1 to 2 each |
| **Total** | **about 205 USD (roughly 285 CAD)** |

Optional: Esper Sentinel (53 to 61) in place of Archivist of Oghma.

---

## Which one to build
Build **Option 1** if you want the deck to be about Hope. It wins through the commander, it is faster, and it has a real combo. Build **Option 2** if "fuck you" is the priority. It is the stronger deck against a tuned Bracket 3 pod because stax plus counters beats most creature decks, but Hope is a supporting piece in it rather than the engine.

Both are cheap to assemble because about 45 of the 99 cards already exist in your decks. The two decks that lose the most are Multiverse Reforged (Azorius mana base, Sunfall, Martial Coup) and Vivi Ornitier (Rhystic Study, Faerie Mastermind, Otawara, Minamo, Spellseeker, Windfall). Vivi is your Bracket 4 deck, so decide whether it is retired before pulling Rhystic Study.

## Verification notes
- Hope Estheim text, cost and stats: Scryfall / Gatherer FIN #226 via search snippets.
- Game Changers (53 cards, Feb 9 2026 update). White: Drannith Magistrate, Enlightened Tutor, Farewell, Humility, Serra's Sanctum, Smothering Tithe, Teferi's Protection. Blue: Consecrated Sphinx, Cyclonic Rift, Fierce Guardianship, Force of Will, Gifts Ungiven, Intuition, Mystical Tutor, Narset Parter of Veils, Rhystic Study, Thassa's Oracle. Colorless in your collection that are also on the list: Mana Vault, Grim Monolith, Chrome Mox, The One Ring, Ancient Tomb. None of those are in either build.
- Bracket 3 rules (October 2025 revision): up to 3 Game Changers, no mass land denial, no chained extra turns, games expected to go turn 6 or later, tutors no longer restricted.
- Delney ruling (2024-02-02): the extra trigger applies to any triggered ability of a creature you control with power 2 or less. Hope is 2/2.
- Heliod + Walking Ballista: Commander Spellbook combo 1274-3693.
- The Wind Crystal: {2}{W}{W} legendary artifact, white spells cost {1} less, life gain doubled.
- Adventurer's Inn: Land — Town, enters and you gain 2 life, taps for {C}.
- Scryfall, EDHREC, Moxfield and Commander Spellbook were blocked by this session's network policy, so prices come from TCGplayer / MTGStocks / mtgdecks search snippets and some are estimates. Re-check the "est." lines before ordering.

Sources: EDHREC Hope Estheim pages (https://edhrec.com/commanders/hope-estheim, /cedh, /upgraded), EDHREC build article (https://edhrec.com/articles/building-an-azorius-mill-commander-deck-with-hope-estheim), Draftsim guide (https://draftsim.com/hope-estheim-edh-deck/), Scryfall FIN #226 (https://scryfall.com/card/fin/226/es/hope-estheim-(hope-estheim)), Gatherer (https://gatherer.wizards.com/FIN/en-us/541/hope-estheim), Game Changers lists (https://mtg.wiki/page/Game_Changers, https://scrollvault.net/guides/game-changers.html, https://edhcheck.com/game-changers/, https://geekydomain.com/blogs/guides/mtg-game-changers-bracket-list), bracket rules (https://draftsim.com/mtg-october-2025-commander-bracket-changes/, https://commanderbrackets.com/bracket-3, https://farseek.ai/blog/commander-brackets-explained), Delney rulings (https://casualplaneswalker.com/card/delney-streetwise-lookout/faq), Heliod + Ballista (https://commanderspellbook.com/combo/1274-3693/), The Wind Crystal (https://scryfall.com/card/fin/43/the-wind-crystal), Adventurer's Inn (https://scryfall.com/card/fin/271/adventurers-inn), prices (https://www.tcgplayer.com/product/216530/magic-jumpstart-bruvac-the-grandiloquent, https://www.tcgplayer.com/product/206666/magic-theros-beyond-death-heliod-sun-crowned, https://mtgdecks.net/prices/delney-streetwise-lookout, https://www.tcgplayer.com/product/212115/magic-ikoria-lair-of-behemoths-drannith-magistrate, https://www.tcgplayer.com/product/240035/magic-modern-horizons-2-esper-sentinel, https://www.tcgplayer.com/product/100224/magic-magic-origins-alhammarrets-archive, https://www.tcgplayer.com/product/15052/magic-10th-edition-beacon-of-immortality, https://mtgdecks.net/prices/boon-reflection, https://www.tcgplayer.com/product/168773/magic-core-set-2019-resplendent-angel, https://mtgdecks.net/prices/serra-ascendant, https://www.tcgplayer.com/product/187194/magic-war-of-the-spark-teferi-time-raveler, https://www.tcgplayer.com/product/221969/magic-zendikar-rising-archon-of-emeria, https://www.tcgplayer.com/product/633412/magic-final-fantasy-hope-estheim, https://mtgdecks.net/prices/archangel-of-thune, https://mtgdecks.net/prices/walking-ballista).
