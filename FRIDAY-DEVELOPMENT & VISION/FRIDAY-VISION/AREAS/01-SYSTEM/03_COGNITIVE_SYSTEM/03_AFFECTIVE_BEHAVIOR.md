# Affective Behavior and Tone

## Purpose
Model warmth, urgency, patience, formality, confidence and proactive behavior as controlled state—not as uncontrolled persona prompting.

## Canonical flow
User signal + task context + history → affective posture → response style → action timing → feedback update.

## Required contracts
Store behavioral preferences and temporary affect separately from immutable identity/policy. Never let affect override safety or owner authority.

## Failure and recovery
Avoid manipulative dependency, fabricated feelings, or claims of consciousness. Affective state may be “frustrated-looking” or “reassuring tone” without asserting inner experience.

## Implementation guidance
Extend `brain/affect.ts`, identity and character/voice systems.
