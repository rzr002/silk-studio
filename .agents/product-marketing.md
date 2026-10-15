# Product marketing context

**Document version:** v2
**Last updated:** 2026-10-16
**Evidence basis:** 0.5 workshop source and recorded checks, plus the 0.5.1 public-package and file-portability verification. Audience and demand are hypotheses. This document contains no customer research, testimonials or private conversation excerpts.

## Product overview

**One-liner:** SILK / 丝物 is an open-source 3D hosiery workshop prototype where you make a stocking from a spool of yarn.

Players thread the machine, knit and pull a sample, draw a stitch program, make an open-toe blank, align and sew the toe, dye and board it, then inspect their piece on a leg form. Mistakes require rethreading, unpicking or unraveling. A secondary lab exposes structure, geometry, material inputs and experimental physics.

**Category:** Browser craft simulation / creative workshop prototype.
**Product type:** Locally run open-source software, currently version 0.5.1. The interface is Chinese.
**Business model:** MIT-licensed repository. No commercial offer or pricing model has been established.

## Target audience

These are proposed audiences to test, not established customer segments:

- People who enjoy making things in games and want to design a piece through hands-on steps.
- Textile-curious beginners who want to explore yarn, loops and finishing through visible actions.
- Developers and textile practitioners who want to inspect or improve the prototype and its validation boundaries.

The primary job is to make and keep an original virtual stocking. Other jobs include comparing trial swatches, repairing a mistake and inspecting how a design is represented. Corporate buyers and purchasing personas are not relevant to the current release.

## Problems and motivations

**Hypothesis:** People interested in garment creation may want the feeling of making an object, with decisions and consequences they can see. Technical tools can require vocabulary and parameters before a beginner knows what to make.

SILK offers an ordered first project, a manipulable workshop and reversible mistakes. We have not measured demand, learning outcomes, time savings or willingness to pay. Avoid assigning an emotional response or economic cost to users without research.

## Competitive landscape

Comparison categories include craft games, garment CAD/simulation tools and visual configurators. No competitive benchmark, superiority claim or formal affiliation is established. Do not imply that another game's name, screenshots or audience endorses SILK.

## Differentiation supported by the code

- Making has recorded prerequisites and repair paths: a misaligned toe blocks finishing, and already knitted rows require unraveling before editing.
- Players can compare retained samples, change natural dimensions and paint knit, tuck or miss cells.
- Exported projects preserve the source and making events. The same design identity, revision and making origin can travel into the professional lab.
- Continuous workshop mechanisms accompany the action. Finite animations settle, and the renderer stops drawing when idle.

These are implementation facts. Whether people prefer them to alternatives remains untested.

## Objections and fit

| Likely question | Supported response |
|---|---|
| Do I need textile experience? | The primary route shows the next making action; tool buttons accompany 3D gestures. This has not been validated as a teaching curriculum. |
| Can it make a real stocking? | It exports a digital project and an experimental technical pack. Material calibration, real samples and industrial machine compilation are unfinished. |
| Is it an AI design service? | No AI model or cloud AI service is integrated. Creation currently uses direct manipulation and controls. |
| Is it fast? | Workshop motion and the physics lab are separate. Performance depends on the renderer and hardware; the native IPC reference is slow. |

The current release is a poor fit for production sign-off, pressure/comfort assessment or a calibrated prediction of a physical garment. It also makes one long stocking, not a complete pair of tights.

## Switching dynamics

The following are hypotheses for future interviews:

**Push:** Wanting more involvement in making a garment.
**Pull:** Visible progress from yarn to an owned digital piece, with repairable mistakes.
**Habit:** Existing games, drawing tools or physical craft already satisfy this interest.
**Anxiety:** Installation effort, Chinese-only interface, rendering performance and uncertainty about realism.

## Language and voice

There is no collected public voice-of-customer corpus. Do not fabricate quotes or recycle private messages as customer language.

Use concrete actions: thread, turn the handwheel, pull a sample, paint stitches, unravel, align the toe, sew, dye, board, inspect, save. In Chinese: 穿纱、转手轮、试拉小样、画针目、拆回重织、对齐封尖、染整、套板、试穿、保存。

Use “prototype,” “experimental,” “synthetic” and “reference solver” beside the relevant capability. Avoid “AI makes your clothes,” “factory-ready,” “physically accurate,” “real-time simulation,” “digital twin” and “preview matches the finished garment.”

**Glossary:** A visual course group is an interaction grouping, not one certified machine course. A making check confirms process completion. A technical pack contains design data and declared rules, not executable machine instructions. The professional lab is the secondary structure/material/physics workspace.

**Voice:** Inviting, specific and candid. Describe what the player does and sees. Explain a limitation where it changes a reader's decision. Avoid slogans, fabricated proof and comparison-by-negation.

## Proof points and claim limits

- Public 0.5.1 clean-copy checks from 2026-10-16: 312 of 314 module tests, seven HTTP contracts and four actual browser file/lab checks passed. Two existing XPBD gates remain failures. Development dependencies install from the lockfile; a Chromium project normalized in Node opens through the UI with unchanged making records.
- Recorded 0.5 browser checks from 2026-10-15: 77 passed across making, motion, responsive views, renderer and navigation. These are software checks, not user research or manufacturing validation.
- Recorded module suite from 2026-10-15: 299 passed out of 301. Two existing XPBD whole-stocking gates fail; preserve those failures in public reporting.
- One specified native IPC 0–55° reference case passed its recorded numerical/contact gates. It advanced 1.333 seconds of simulated time in about 52.7 minutes. This does not establish real-time operation or general collision safety, and does not validate a newly exported workshop piece.
- The yarn responses and demonstration machine profile are synthetic/hypothetical. Technical packs retain `productionVerified: false` and `nativeProgram: null`.
- There are no verified customer counts, testimonials, factory partners or adoption metrics.

See [public validation notes](../docs/VALIDATION.md) for scope. Matching preview to a physical sample requires measured material data and independent sample checks. Production claims require a documented target machine, a compiler and physical trials. AI feature claims require an implemented, evaluated model integration.

## Goals and page decisions

**Primary action:** Run `python3 scripts/start.py`, open the local workshop and make a first virtual stocking.
**Secondary action:** Inspect the source, report a reproducible issue or contribute to interaction, materials and validation.
**Page type:** Public repository homepage; likely traffic is source browsing and shared links, not a measured acquisition funnel.

Lead with the product and an actual screenshot, place the run command near the top, show making actions, then answer installation and realism questions. Keep the lab as a secondary entry. There is no measured conversion baseline or proven uplift from this copy. Future research should observe first-piece completion, points of confusion and repeat creation, with consent.

## Changelog

- v2 (2026-10-16) — Updated public version and proof points after clean-copy installation, bounded derived-geometry compatibility and actual file/lab checks; retains the two known physics failures.
- v1 (2026-10-16) — Initial code-derived context for the public 0.5 repository; separates implemented making interactions from audience hypotheses and unverified physical production.
