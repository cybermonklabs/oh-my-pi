package omprpc

import (
	"context"
	"fmt"
)

// GetEntries sends "get_entries": the session's append-history, all of it, or
// with Since the entries strictly after that durable entry.
//
// The session's `entry_patch` records are not listed: an entry whose parent
// is a record, and a LeafID that names one, take the record's parent, also
// for a record an earlier Since read returned. The client does not apply the
// records, and must not: the server serves its live entries
// (packages/coding-agent/src/modes/rpc/rpc-compat.ts:19-22,
// packages/coding-agent/src/session/session-manager.ts:6973), which already
// carry each record's fields. patchEntries sets them before it appends the
// record (session-manager.ts:6667-6669), and a load applies the records it
// reads (session-manager.ts:4769). A record the server holds keeps its fields
// after a later rewrite-only pass replaced them in the entry, for example
// images a later pass dropped from an elided result: only the line a full
// rewrite writes loses them (packages/coding-agent/src/session/entry-patches.ts:33-36,
// withoutEntryPatches at :207-209). Applying such a record again would bring
// the replaced values back.
//
// c.Commands.GetEntries returns the reply as the server sent it, records
// included.
func (c *Client) GetEntries(ctx context.Context, p GetEntriesCommand) (SessionEntries, error) {
	out, err := c.Commands.GetEntries(ctx, p)
	if err != nil {
		return out, err
	}
	c.entryPatchMu.Lock()
	defer c.entryPatchMu.Unlock()
	if p.Since == nil || c.entryRecordParents == nil {
		c.entryRecordParents = recordParents{}
	}
	out.Entries = entriesPastRecords(out.Entries, c.entryRecordParents)
	out.LeafID = pastRecords(out.LeafID, c.entryRecordParents)
	return out, nil
}

// GetTree sends "get_tree": the session tree and the current leaf id.
//
// The session's `entry_patch` records are not listed: the children of a
// record node take its place among its parent's children, with the record's
// parent as their entries' parent, and a LeafID that names a record names
// that parent. The client does not apply the records, and must not, for the
// reason GetEntries gives: the tree's entries are the server's live entries
// (packages/coding-agent/src/session/session-manager.ts:7029), which already
// carry each record's fields. The tree is read and written again once,
// however deep it nests.
//
// c.Commands.GetTree returns the reply as the server sent it, records
// included.
func (c *Client) GetTree(ctx context.Context) (SessionTree, error) {
	out, err := c.Commands.GetTree(ctx)
	if err != nil {
		return out, err
	}
	parents := recordParents{}
	tree, err := treePastRecords(out.Tree, parents)
	if err != nil {
		return out, fmt.Errorf("omprpc: get_tree result: %w", err)
	}
	out.Tree = tree
	out.LeafID = pastRecords(out.LeafID, parents)
	return out, nil
}

// SubagentTranscriptRead is a get_subagent_messages reply as
// Client.GetSubagentMessages returns it: `entry_patch` records applied within
// the reply and not listed. An entry whose parent is a record of the reply
// takes the record's parent, and Messages are the messages of Entries.
type SubagentTranscriptRead struct {
	SubagentMessages
	// EntryPatches are the patches of this reply's records that name an entry
	// not in this reply (one an earlier call returned), in file order, as
	// EntryPatchesOf gives them.
	EntryPatches []EntryPatch
}

// GetSubagentMessages sends "get_subagent_messages": the entries of a
// subagent transcript from FromByte (pass the last reply's NextByte).
//
// The server reads the transcript file in windows. The `entry_patch` records
// of this reply apply to its entries, as the server applies them, and are not
// listed; an entry whose parent is a record of this reply takes the record's
// parent. A patch that names an entry not in this reply, one an earlier call
// returned, is listed in EntryPatches, in file order. The client keeps nothing
// across calls: a caller that holds the entries of earlier calls applies each
// patch, in order, to the entry with its EntryID when EntryAcceptsPatch holds,
// with SetPatchedFields, and decodes that entry's message again.
//
// c.Commands.GetSubagentMessages returns the reply as the server sent it.
func (c *Client) GetSubagentMessages(ctx context.Context, p GetSubagentMessagesCommand) (SubagentTranscriptRead, error) {
	reply, err := c.Commands.GetSubagentMessages(ctx, p)
	if err != nil {
		return SubagentTranscriptRead{SubagentMessages: reply}, err
	}
	ids := make(map[string]bool, len(reply.Entries))
	for _, entry := range reply.Entries {
		if id, ok := targetIDOf(entry); ok {
			ids[id] = true
		}
	}
	var patches []EntryPatch
	for _, entry := range reply.Entries {
		if !IsEntryPatchRecord(entry) {
			continue
		}
		recordPatches, _ := EntryPatchesOf(entry)
		for _, patch := range recordPatches {
			if !ids[patch.EntryID] {
				patches = append(patches, patch)
			}
		}
	}
	changed := ApplyEntryPatches(reply.Entries, nil)
	reply.Entries = entriesPastRecords(reply.Entries, recordParents{})
	if changed {
		messages := make([]AgentMessage, 0, len(reply.Messages))
		for _, entry := range reply.Entries {
			if kind, _ := rawString(entry["type"]); kind != "message" {
				continue
			}
			var message AgentMessage
			if err := message.UnmarshalJSON(entry["message"]); err != nil {
				return SubagentTranscriptRead{SubagentMessages: reply}, fmt.Errorf("omprpc: get_subagent_messages result: %w", err)
			}
			messages = append(messages, message)
		}
		reply.Messages = messages
	}
	return SubagentTranscriptRead{SubagentMessages: reply, EntryPatches: patches}, nil
}
