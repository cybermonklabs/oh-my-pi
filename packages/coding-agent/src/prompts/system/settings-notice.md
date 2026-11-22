<system-notice id="settings">
{{#if released}}
Settings changed after a settings notice above, and the change it described is no longer held: the system prompt and tool definitions above follow the current settings. This lists only what that notice said that no longer holds; anything else it said still holds.
{{else}}
Settings changed after the system prompt and tool definitions above were written. The change is held: they stay as written until the prompt is rebuilt with it, at the first request made at {{rebuildBy}} or later, or sooner if the cached prompt expires first. This lists only what changed; any setting not named here is unaffected.
{{/if}}
{{#each changes}}
- `{{id}}`: {{#if secret}}changed (value withheld){{else}}`{{previous}}` → `{{next}}`{{/if}}
{{/each}}
{{#if releasedChanges.length}}
These settings changed after a settings notice above, and the change it described is no longer held: the system prompt and tool definitions above follow their current values.
{{#each releasedChanges}}
- `{{id}}`: {{#if secret}}changed (value withheld){{else}}`{{previous}}` → `{{next}}`{{/if}}
{{/each}}
{{/if}}
{{#if disabledTools.length}}
Disabled by this change; they stay listed until the rebuild, and calls to them are refused from now on: {{#list disabledTools join=", "}}`{{this}}`{{/list}}
{{/if}}
{{#if unlistedDisabledTools.length}}
Disabled by this change; calls to them are refused from now on: {{#list unlistedDisabledTools join=", "}}`{{this}}`{{/list}}
{{/if}}
{{#if reenabledTools.length}}
No longer disabled; calls to them run again from now on: {{#list reenabledTools join=", "}}`{{this}}`{{/list}}
{{/if}}
{{#if enabledTools.length}}
Enabled by this change; available after the rebuild: {{#list enabledTools join=", "}}`{{this}}`{{/list}}
{{/if}}
{{#if noLongerEnabledTools.length}}
{{#if released}}No longer enabled; not available: {{else}}No longer enabled; not available after the rebuild: {{/if}}{{#list noLongerEnabledTools join=", "}}`{{this}}`{{/list}}
{{/if}}
</system-notice>
