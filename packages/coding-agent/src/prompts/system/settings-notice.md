<system-notice id="settings">
Settings changed after the system prompt and tool definitions above were written. They stay as written until the next prompt rebuild; the values below apply now. This lists only what changed; any setting not named here is unaffected.
{{#each changes}}
- `{{id}}`: {{#if secret}}changed (value withheld){{else}}`{{previous}}` → `{{next}}`{{/if}}
{{/each}}
{{#if disabledTools.length}}
Disabled by this change; they stay listed until the rebuild, and calls to them are refused: {{#list disabledTools join=", "}}`{{this}}`{{/list}}
{{/if}}
{{#if enabledTools.length}}
Enabled by this change; available after the next prompt rebuild: {{#list enabledTools join=", "}}`{{this}}`{{/list}}
{{/if}}
</system-notice>
