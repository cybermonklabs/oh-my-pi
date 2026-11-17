<system-notice id="task-agents">
Agents `task` and eval `agent()`/`workpool()` can spawn changed since the `task` description listed them. This lists only what changed; any agent not named here is unaffected.
{{#if added.length}}
Now available:
{{#each added}}
- `{{name}}`: {{description}}
{{/each}}
{{/if}}
{{#if removed.length}}
No longer available; calls fail:
{{#each removed}}
- `{{this}}`
{{/each}}
{{/if}}
</system-notice>
