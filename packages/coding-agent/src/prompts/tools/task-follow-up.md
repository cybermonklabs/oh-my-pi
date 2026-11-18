{{#if aborted}}
{{#if resumable}}
{{agentId}} was stopped but is still resumable{{#if budgetCrossed}} (crossed its soft request budget: {{budgetRequests}}/{{budgetLimit}} requests){{/if}} — {{#if ircEnabled}}message it via `write agent://{{agentId}}` to resume; {{/if}}{{#if transcriptAvailable}}transcript at history://{{agentId}}{{else}}transcript unavailable{{/if}}
{{else}}
{{agentId}} was aborted — {{#if transcriptAvailable}}transcript at history://{{agentId}}{{else}}transcript unavailable{{/if}}
{{/if}}
{{else}}
{{#if isolated}}
{{agentId}} ran isolated and cannot be resumed or messaged — transcript at history://{{agentId}}
{{else}}
{{agentId}} is now idle{{#if budgetCrossed}} after crossing its soft request budget ({{budgetRequests}}/{{budgetLimit}} requests) and wrapping up on its own{{/if}} — {{#if ircEnabled}}message it via `write agent://{{agentId}}` to follow up{{#if budgetCrossed}} and continue it in the same session with full context and no request budget on that turn{{/if}}; {{/if}}transcript at history://{{agentId}}
{{/if}}
{{/if}}
