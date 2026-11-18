<task-result id="{{id}}" agent="{{agentName}}" status="{{status}}" duration="{{duration}}"{{#if missingYield}} missing-yield="{{missingYield}}"{{/if}}>
{{#if truncated}}{{#if meta}}<meta lines="{{meta.lineCount}}" size="{{meta.charSize}}" />{{/if}}{{/if}}
{{#if modelFallback}}
<model served="{{modelFallback.served}}"{{#if modelFallback.requested}} requested="{{modelFallback.requested}}"{{/if}} fallback="true"{{#if modelFallback.reason}}>{{modelFallback.reason}}</model>{{else}} />{{/if}}
{{/if}}
{{#if abortReason}}
<abort-reason>{{abortReason}}{{#if resumable}} — the agent is still live with its full context; message it via `write agent://{{id}}` to resume instead of redoing the work.{{/if}}</abort-reason>
{{else}}
{{#if budgetCrossed}}
<budget-notice requests="{{budgetRequests}}" budget="{{budgetLimit}}">This run crossed its soft request budget{{#if resumable}} and is still resumable: message it via `write agent://{{id}}` to continue in the same session with its full context and no request budget on that turn.{{else}} before yielding.{{/if}}</budget-notice>
{{/if}}
{{/if}}
{{#if error}}
<error>{{error}}</error>
{{/if}}
{{#if retryFailure}}
<retry-failure kind="{{retryFailure.kind}}"{{#if retryFailure.resetAt}} reset-at="{{retryFailure.resetAt}}"{{/if}} />
{{/if}}
{{#if truncated}}
<preview full-output="agent://{{id}}">
{{preview}}
</preview>
{{else}}
<output>
{{preview}}
</output>
{{/if}}
{{#if mergeSummary}}
<merge-summary>
{{mergeSummary}}
</merge-summary>
{{/if}}
</task-result>
