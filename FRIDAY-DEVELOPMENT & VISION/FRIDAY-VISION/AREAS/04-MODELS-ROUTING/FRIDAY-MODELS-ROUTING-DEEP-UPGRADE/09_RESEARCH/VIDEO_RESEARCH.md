# Video / conference research index

The video layer was checked for implementation ideas in addition to written docs. Videos are used as **secondary evidence**; official API documentation remains the implementation authority.

## Microsoft

- “Introducing the model router in Foundry Models” — Microsoft Azure
  https://www.youtube.com/watch?v=_HrL3TubGbI
- “Model Router + GPT-5 Models in Microsoft Foundry” — Microsoft Developer
  https://www.youtube.com/watch?v=2NL2XpigH0A

Observed implementation themes:
- deploy a router as a model endpoint;
- let the router select among model families in milliseconds;
- use multi-turn context;
- expose routing as an infrastructure capability rather than embedding it into every agent.

## Video-research rule

Do not implement a feature because a video demo shows it. Trace the feature back to an official API/SDK contract before putting it into FRIDAY.

## Future video ingestion

The architecture should allow a research source collector to index official conference/tutorial videos by:

`provider → video → timestamp → claim → official doc → implementation note`

This keeps video-derived knowledge auditable rather than turning videos into undocumented assumptions.
