<system-notice id="per-call-models">
The models a per-call `model` may name changed; this list replaces the one in the `task` and eval `agent()`/`workpool()` descriptions. Approved: {{#list roles join=", "}}{{#list patterns join=", "}}`{{this}}`{{/list}} ({{role}}){{/list}}{{#if roles.length}}; {{/if}}{{#if parentModelWithheld}}{{else}}your own current model; {{/if}}the selected bundled/user agent's own configured model.{{#if allowlist.length}} Allowlist: {{#list allowlist join=", "}}`{{this}}`{{/list}} (must also be approved).{{/if}}
</system-notice>
