# Heartbeat delivery after unload

An unloaded chat can report `canAcceptDirectInput=null`. That temporary metadata does not establish whether the loaded chat accepts direct input. The scheduler loads an eligible existing target first, then reads its actual capability/status before deciding whether to send. Archive membership and runtime state remain distinct: an archived target is not automatically unarchived.

A cached local subscription does not prove that the server still has the target loaded. The backend refreshes observation for a known unloaded target, even when its ID is already cached, and then reads the target again. The shared direct-send/watch-destination path uses the same refresh behavior. Explicit resume can reach the backend when unloaded capability metadata is unavailable.

Regression scenarios cover initial successful delivery, subsequent unload/null metadata, next due delivery and duplicate ticks; active-after-load/still-indirect states; unload during the final check; and official Proxy transport over an isolated socket fixture. They assert the selected target, submission count and absence of accidental steer or a fallback destination. Fixture success is not a claim about every real target's eligibility or every App Server version.

A pre-existing suspended registration is not silently reactivated by this code change. Re-registration or update, expiry changes, and any operational replay are separate actions. The correction adds no permission system, catalog/worktime requirement or background external-service polling.
