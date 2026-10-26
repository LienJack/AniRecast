# Quality Guidelines

> Code quality standards for backend development.

---

## Overview

<!--
Document your project's quality standards here.

Questions to answer:
- What patterns are forbidden?
- What linting rules do you enforce?
- What are your testing requirements?
- What code review standards apply?
-->

(To be filled by the team)

---

## Forbidden Patterns

<!-- Patterns that should never be used and why -->

(To be filled by the team)

---

## Required Patterns

### Still clips have no implicit camera motion

`packages/media/src/compose.ts` exports `stillClip(image, output, spec, opts)`. Omitting
`spec.zoom` means zero push-in; only an explicit nonzero value may animate the camera.
`anirecast take still` holds the approved board at the source FPS and exact shot frame count.
Do not assume that a still input guarantees still output: FFmpeg's `zoompan` can animate it.
The media regression test compares the detailed first and last decoded frames with luma
PSNR above 50 dB (allowing H.264 noise), in addition to checking frame count, size and FPS.
Frame-count checks or sparse contact sheets alone do not catch unintended zoom.

<!-- Patterns that must always be used -->

(To be filled by the team)

---

## Testing Requirements

<!-- What level of testing is expected -->

(To be filled by the team)

---

## Code Review Checklist

<!-- What reviewers should check -->

(To be filled by the team)
