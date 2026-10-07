# Target Architecture

FRIDAY is split into five lifecycle domains:

```text
SOURCE / RELEASE
       |
       v
APPLICATION PAYLOAD  <---- replaceable by official update
       |
       +---- official runtimes/components
       |
       +---- updater/recovery
       |
       v
USER-OWNED ECOSYSTEM  <---- preserved across official updates
       |
       +---- agents / skills / tools / plugins / workflows
       +---- optional runtimes / models
       |
       v
USER DATA              <---- never replaced by application update
       |
       +---- memory / knowledge / projects / settings / downloads
```

The update plane may replace official application payload, but it must not treat user-owned resources as release files.

The install manager owns lifecycle operations for optional/user components. The release engine owns FRIDAY release version decisions. The updater owns official application update transactions. The environment registry owns runtime/component state. Each responsibility has one owner.
