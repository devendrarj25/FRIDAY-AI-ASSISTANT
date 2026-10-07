# Diagram and Animation Engine

## Purpose
Generate accurate explanatory diagrams and runtime visualizations from typed graph data. Static diagrams are SVG; animated runtime views are HTML/CSS/SVG/canvas only when needed.

## Canonical flow
Structured graph → layout → SVG renderer → validation → artifact. Runtime: event stream → state projection → animation layer.

## Required contracts
Diagram nodes/edges have stable IDs linked to source component/event IDs so visualizations can be traced back to actual system objects.

## Failure and recovery
Never infer live system state from decorative animation. Only actual execution events may drive “live” status.

## Implementation guidance
Reuse existing flow-chart/wiring/stage surfaces where possible.
