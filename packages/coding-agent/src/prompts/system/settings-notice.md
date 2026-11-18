<system-notice id="settings">
Settings changed after the system prompt and tool definitions above were written. The change is held: they stay as written until the prompt is rebuilt with it, at the first request made at {{rebuildBy}} or later, or sooner if the cached prompt expires first. This lists only what changed; any setting not named here is unaffected.
{{#each changes}}
- `{{id}}`: {{#if secret}}changed (value withheld){{else}}`{{previous}}` → `{{next}}`{{/if}}
{{/each}}
{{#if disabledTools.length}}
Disabled by this change; they stay listed until the rebuild, and calls to them are refused from now on: {{#list disabledTools join=", "}}`{{this}}`{{/list}}
{{/if}}
{{#if enabledTools.length}}
Enabled by this change; available after the rebuild: {{#list enabledTools join=", "}}`{{this}}`{{/list}}
{{/if}}
</system-notice>
