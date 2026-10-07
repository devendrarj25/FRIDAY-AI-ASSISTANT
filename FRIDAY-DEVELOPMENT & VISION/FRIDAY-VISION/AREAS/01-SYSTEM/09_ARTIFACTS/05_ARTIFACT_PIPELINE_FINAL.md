# Artifact Pipeline — Final

All generated or transformed artifacts use one envelope:
request → source inputs → plan → generator/tool → intermediate artifacts → validators → provenance → storage → preview/delivery.

Supported families include text, markdown, PDF, DOCX, spreadsheets, presentations, images, audio, video, diagrams, code, datasets, archives and structured JSON.

Every artifact records creator run, source lineage, transformations, validation results and integrity metadata. A file existing on disk is not proof it is correct; validators and open/readback checks establish evidence.
