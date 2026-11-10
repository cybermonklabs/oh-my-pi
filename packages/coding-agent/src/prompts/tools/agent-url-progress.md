# {{id}} ({{status}})

{{#if aborted}}
The run was aborted and will never publish output: what follows is as far as it got. Full transcript: `history://{{id}}`.
{{else}}
No final output yet: `agent://{{id}}` shows progress until the run publishes its output. Full transcript: `history://{{id}}`.
{{/if}}
{{#each sections}}

## Yield{{#if labels}} [{{labels}}]{{/if}}

```json
{{data}}
```
{{/each}}
{{#if lastText}}

## Latest assistant text

{{lastText}}
{{/if}}
{{#if empty}}

Nothing produced yet.
{{/if}}
