# Real-Time Voice — Full Duplex

Voice must remain listening while speaking so it can detect genuine user takeover. The loop is:
transport → echo cancellation → VAD/turn detection → streaming STT → executive/orchestrator → streaming model/tool work → clause-level TTS → playback.

On barge-in:
1. classify likely human takeover vs noise/backchannel;
2. immediately cancel/duck TTS playback;
3. cancel or suspend unnecessary in-flight generation;
4. preserve exactly what was actually spoken;
5. retain tool/task state;
6. accept the new user turn;
7. continue the same task/goal if appropriate.

The voice shell must not create a second brain. Chat/Voice/Mobile all operate on the same turn/task/event state.
