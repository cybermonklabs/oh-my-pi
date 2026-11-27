package omprpc

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"
)

const (
	elidedContent = `[{"type":"text","text":"[elided: see artifact://1]"}]`
	heavyContent  = `[{"type":"text","text":"heavy tool output heavy tool output"}]`
)

func object(t *testing.T, text string) map[string]json.RawMessage {
	t.Helper()
	members, err := decodeObject([]byte(text), "test")
	if err != nil {
		t.Fatalf("%s: %v", text, err)
	}
	return members
}

func parentJSON(parent string) string {
	if parent == "" {
		return "null"
	}
	return fmt.Sprintf("%q", parent)
}

func userEntry(id, parent, text string) string {
	return fmt.Sprintf(`{"type":"message","id":%q,"parentId":%s,"timestamp":"t","message":{"role":"user","content":%q,"timestamp":1}}`, id, parentJSON(parent), text)
}

func assistantEntry(id, parent, extra string) string {
	return fmt.Sprintf(`{"type":"message","id":%q,"parentId":%s,"timestamp":"t","message":{"role":"assistant","content":[{"type":"text","text":"hi"}],"api":"x","provider":"p","model":"m","usage":{},"stopReason":"stop","timestamp":2%s}}`, id, parentJSON(parent), extra)
}

func toolResultEntry(id, parent, content string) string {
	return fmt.Sprintf(`{"type":"message","id":%q,"parentId":%s,"timestamp":"t","message":{"role":"toolResult","toolCallId":"c1","toolName":"bash","content":%s,"isError":false,"timestamp":3}}`, id, parentJSON(parent), content)
}

func compactionEntry(id string) string {
	return fmt.Sprintf(`{"type":"compaction","id":%q,"parentId":null,"timestamp":"t","summary":"s","firstKeptEntryId":"u1","tokensBefore":100,"tokensAfter":80}`, id)
}

func recordEntry(id, parent, patches string) string {
	return fmt.Sprintf(`{"type":"custom","customType":"entry_patch","id":%q,"parentId":%s,"timestamp":"t","data":{"patches":%s}}`, id, parentJSON(parent), patches)
}

func entries(t *testing.T, texts ...string) []map[string]json.RawMessage {
	t.Helper()
	out := make([]map[string]json.RawMessage, 0, len(texts))
	for _, text := range texts {
		out = append(out, object(t, text))
	}
	return out
}

// normalized is value as plain decoded JSON, for comparisons that ignore key
// order and spacing.
func normalized(t *testing.T, value any) any {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	if err := json.Unmarshal(encoded, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func assertSameJSON(t *testing.T, got, want any) {
	t.Helper()
	if g, w := normalized(t, got), normalized(t, want); !reflect.DeepEqual(g, w) {
		gotText, _ := json.Marshal(g)
		wantText, _ := json.Marshal(w)
		t.Fatalf("got  %s\nwant %s", gotText, wantText)
	}
}

func messageMember(t *testing.T, entry map[string]json.RawMessage, key string) json.RawMessage {
	t.Helper()
	return object(t, string(entry["message"]))[key]
}

func TestApplyEntryPatchesSetsTheRecordsFields(t *testing.T) {
	list := entries(t,
		toolResultEntry("t1", "", heavyContent),
		recordEntry("p1", "t1", `[{"entryId":"t1","message":{"content":`+elidedContent+`,"prunedAt":5}}]`),
	)
	if !ApplyEntryPatches(list, nil) {
		t.Fatal("no field set")
	}
	assertSameJSON(t, messageMember(t, list[0], "content"), json.RawMessage(elidedContent))
	assertSameJSON(t, messageMember(t, list[0], "prunedAt"), 5)
}

func TestApplyEntryPatchesNewestWinsAndRepeatsChangeNothing(t *testing.T) {
	list := entries(t,
		compactionEntry("c1"),
		recordEntry("p1", "", `[{"entryId":"c1","entry":{"tokensAfter":40,"warning":"first"}}]`),
		recordEntry("p2", "", `[{"entryId":"c1","entry":{"tokensAfter":20}}]`),
	)
	ApplyEntryPatches(list, nil)
	once := normalized(t, list)
	ApplyEntryPatches(list, nil)
	assertSameJSON(t, list, once)
	assertSameJSON(t, []json.RawMessage{list[0]["tokensAfter"], list[0]["warning"]}, []any{20, "first"})
}

func TestApplyEntryPatchesBeforeTheTarget(t *testing.T) {
	list := entries(t,
		recordEntry("p1", "", `[{"entryId":"a1","message":{"elidedOutputTokens":9}}]`),
		assistantEntry("a1", "", ""),
	)
	if !ApplyEntryPatches(list, nil) {
		t.Fatal("no field set")
	}
	assertSameJSON(t, messageMember(t, list[1], "elidedOutputTokens"), 9)
}

func TestApplyEntryPatchesSkips(t *testing.T) {
	list := entries(t,
		userEntry("u1", "", "go"),
		`{"type":"custom","customType":"entry_patch","id":"bad","data":{"patches":"not a list"}}`,
		recordEntry("p1", "", `[{"entryId":"gone","message":{"prunedAt":1}}]`),
		// `continued` is an assistant field; a user message lacks it.
		recordEntry("p2", "", `[{"entryId":"u1","message":{"continued":true}}]`),
		// An assistant's content is a list of blocks, never a string.
		recordEntry("p3", "", `[{"entryId":"a1","message":{"content":"flat"}}]`),
		assistantEntry("a1", "", ""),
	)
	var skipped []EntryPatchSkip
	if ApplyEntryPatches(list, func(skip EntryPatchSkip) { skipped = append(skipped, skip) }) {
		t.Fatal("a field was set")
	}
	want := []EntryPatchSkip{
		{Reason: EntryPatchMalformed, RecordID: "bad"},
		{Reason: EntryPatchMissingTarget, RecordID: "p1", EntryID: "gone"},
		{Reason: EntryPatchMisfit, RecordID: "p2", EntryID: "u1"},
		{Reason: EntryPatchMisfit, RecordID: "p3", EntryID: "a1"},
	}
	if !reflect.DeepEqual(skipped, want) {
		t.Fatalf("skipped %+v", skipped)
	}
}

func TestEntryPatchesOfValidatesEachField(t *testing.T) {
	for _, data := range []string{
		`{"patches":[{"entryId":1}]}`,
		`{"patches":[{"entryId":"x","entry":{"warning":3}}]}`,
		`{"patches":[{"entryId":"x","entry":{"tokensAfter":"1"}}]}`,
		`{"patches":[{"entryId":"x","entry":{"tokensAfter":true}}]}`,
		`{"patches":[{"entryId":"x","entry":{"preserveData":[]}}]}`,
		`{"patches":[{"entryId":"x","message":{"continued":false}}]}`,
		`{"patches":[{"entryId":"x","message":{"content":[{"text":"no type"}]}}]}`,
		`{"patches":[{"entryId":"x","message":{"prunedAt":null}}]}`,
		`{"patches":{}}`,
	} {
		if _, ok := EntryPatchesOf(object(t, `{"type":"custom","customType":"entry_patch","data":`+data+`}`)); ok {
			t.Errorf("accepted %s", data)
		}
	}
	patches, ok := EntryPatchesOf(object(t, recordEntry("p1", "", `[
		{"entryId":"x","entry":{"warning":"w","tokensAfter":1,"preserveData":{},"content":"c"}},
		{"entryId":"y","message":{"retryRecovery":{},"continued":true,"contextSnapshot":{},"elidedOutputTokens":1,"prunedAt":2.5,"content":[]}}
	]`)))
	if !ok || len(patches) != 2 || patches[0].EntryID != "x" || patches[1].Message == nil {
		t.Fatalf("patches %+v, %v", patches, ok)
	}
}

func TestEntryAcceptsPatchByKindAndRole(t *testing.T) {
	patch := func(text string) EntryPatch {
		parsed, ok := parseEntryPatch(json.RawMessage(text))
		if !ok {
			t.Fatalf("patch %s", text)
		}
		return parsed
	}
	customMessage := object(t, `{"type":"custom_message","id":"m1","content":"long"}`)
	cases := []struct {
		entry map[string]json.RawMessage
		patch string
		want  bool
	}{
		{object(t, compactionEntry("c1")), `{"entryId":"c1","entry":{"warning":"w"}}`, true},
		{customMessage, `{"entryId":"m1","entry":{"warning":"w"}}`, false},
		{customMessage, `{"entryId":"m1","entry":{"content":"short"}}`, true},
		{object(t, compactionEntry("c1")), `{"entryId":"c1","entry":{"content":"x"}}`, false},
		{object(t, userEntry("u1", "", "go")), `{"entryId":"u1","message":{"content":"short"}}`, true},
		{object(t, toolResultEntry("t1", "", heavyContent)), `{"entryId":"t1","message":{"content":"short"}}`, false},
		{object(t, toolResultEntry("t1", "", heavyContent)), `{"entryId":"t1","message":{"prunedAt":1}}`, true},
		{object(t, assistantEntry("a1", "", "")), `{"entryId":"a1","message":{"prunedAt":1}}`, false},
		{object(t, compactionEntry("c1")), `{"entryId":"c1","message":{"prunedAt":1}}`, false},
		{object(t, `{"type":"message","id":"x1","message":{"role":"custom","content":"c"}}`), `{"entryId":"x1","message":{"content":"d"}}`, false},
	}
	for _, c := range cases {
		if got := EntryAcceptsPatch(c.entry, patch(c.patch)); got != c.want {
			t.Errorf("%s on %s: %v", c.patch, c.entry["type"], got)
		}
	}
	held := object(t, `{"type":"message","id":"b1","message":{"role":"user","timestamp":1}}`)
	SetPatchedFields(held, patch(`{"entryId":"b1","message":{"content":"x"}}`))
	if _, present := object(t, string(held["message"]))["content"]; present {
		t.Fatal("set a content the message does not hold")
	}
}

func TestEntriesPastRecords(t *testing.T) {
	parents := recordParents{}
	kept := entriesPastRecords(entries(t,
		`{"type":"session","id":"s"}`,
		userEntry("u1", "", "go"),
		recordEntry("p1", "u1", "[]"),
		recordEntry("p2", "p1", "[]"),
		userEntry("u2", "p2", "x"),
	), parents)
	var got [][2]string
	for _, entry := range kept {
		id, _ := rawString(entry["id"])
		got = append(got, [2]string{id, string(entry["parentId"])})
	}
	if want := [][2]string{{"s", ""}, {"u1", "null"}, {"u2", `"u1"`}}; !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v", got)
	}
	p2, u2 := "p2", "u2"
	if leaf := pastRecords(&p2, parents); leaf == nil || *leaf != "u1" {
		t.Fatalf("leaf on p2: %v", leaf)
	}
	if leaf := pastRecords(&u2, parents); leaf != &u2 {
		t.Fatalf("leaf on u2: %v", leaf)
	}
	// A later read relinks past a record an earlier read held.
	later := entriesPastRecords(entries(t, userEntry("u3", "p1", "y")), parents)
	if string(later[0]["parentId"]) != `"u1"` {
		t.Fatalf("u3 parent %s", later[0]["parentId"])
	}
}

// shape is tree as nested [id, parent, children] lists.
func shape(t *testing.T, tree []map[string]json.RawMessage) []any {
	t.Helper()
	var out []any
	for _, node := range tree {
		var children []map[string]json.RawMessage
		if err := json.Unmarshal(node["children"], &children); err != nil {
			t.Fatal(err)
		}
		entry := object(t, string(node["entry"]))
		id, _ := rawString(entry["id"])
		out = append(out, []any{id, string(entry["parentId"]), shape(t, children)})
	}
	return out
}

func TestTreePastRecordsSplicesRecordNodes(t *testing.T) {
	node := func(entry string, children ...string) string {
		return fmt.Sprintf(`{"entry":%s,"children":[%s]}`, entry, strings.Join(children, ","))
	}
	var roots []map[string]json.RawMessage
	if err := json.Unmarshal([]byte("["+node(recordEntry("r0", "", "[]"),
		node(userEntry("u1", "r0", "go"),
			node(recordEntry("p1", "u1", "[]"), node(recordEntry("p2", "p1", "[]"), node(userEntry("u2", "p2", "after")))),
			node(userEntry("x1", "u1", "branch")),
		),
	)+"]"), &roots); err != nil {
		t.Fatal(err)
	}
	parents := recordParents{}
	tree, err := treePastRecords(roots, parents)
	if err != nil {
		t.Fatal(err)
	}
	want := []any{[]any{"u1", "null", []any{[]any{"u2", `"u1"`, []any(nil)}, []any{"x1", `"u1"`, []any(nil)}}}}
	if got := shape(t, tree); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v", got)
	}
	p2, r0 := "p2", "r0"
	if leaf := pastRecords(&p2, parents); leaf == nil || *leaf != "u1" {
		t.Fatalf("leaf on p2: %v", leaf)
	}
	if leaf := pastRecords(&r0, parents); leaf != nil {
		t.Fatalf("leaf on r0: %v", *leaf)
	}
}

// If the walk recursed, or split each level again, a chain of 100,000 entries
// would overflow encoding/json's limits or take quadratic time.
func TestTreePastRecordsSplicesADeepChainInOnePass(t *testing.T) {
	const depth = 100_000
	var children bytes.Buffer
	children.WriteByte('[')
	for index := 1; index < depth; index++ {
		entry := userEntry(fmt.Sprintf("e%d", index), fmt.Sprintf("e%d", index-1), "x")
		if index%2 == 1 {
			entry = recordEntry(fmt.Sprintf("e%d", index), fmt.Sprintf("e%d", index-1), "[]")
		}
		fmt.Fprintf(&children, `{"entry":%s,"children":[`, entry)
	}
	children.WriteString(strings.Repeat("]}", depth-1))
	children.WriteByte(']')
	root := map[string]json.RawMessage{
		"entry":    json.RawMessage(userEntry("e0", "", "x")),
		"children": children.Bytes(),
	}
	started := time.Now()
	tree, err := treePastRecords([]map[string]json.RawMessage{root}, recordParents{})
	if err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(started); elapsed > 30*time.Second {
		t.Fatalf("took %v", elapsed)
	}
	// Walk the written chain as the host writes one: each node's entry, then its only child.
	text := tree[0]["children"]
	at, seen, parent := 0, 1, "e0"
	for {
		if bytes.HasPrefix(text[at:], []byte("[]")) {
			break
		}
		if !bytes.HasPrefix(text[at:], []byte(`[{"entry":`)) {
			t.Fatalf("node %d: %.60q", seen, text[at:])
		}
		at += len(`[{"entry":`)
		end, err := scanValue(text, at)
		if err != nil {
			t.Fatal(err)
		}
		entry := object(t, string(text[at:end]))
		id, _ := rawString(entry["id"])
		if want := fmt.Sprintf("e%d", seen*2); id != want || string(entry["parentId"]) != fmt.Sprintf("%q", parent) {
			t.Fatalf("node %d: %s, parent %s", seen, id, entry["parentId"])
		}
		parent = id
		seen++
		at = end + len(`,"children":`)
	}
	if seen != depth/2 {
		t.Fatalf("chain of %d nodes", seen)
	}
}

// answered runs call, answers the command it sends with data, and returns
// what call returns.
func answered[T any](t *testing.T, s *fakeServer, data string, call func() (T, error)) T {
	t.Helper()
	results := make(chan T, 1)
	failures := make(chan error, 1)
	go func() {
		value, err := call()
		if err != nil {
			failures <- err
			return
		}
		results <- value
	}()
	s.respond(s.recv(), data)
	select {
	case value := <-results:
		return value
	case err := <-failures:
		t.Fatal(err)
	case <-time.After(5 * time.Second):
		t.Fatal("no result")
	}
	var zero T
	return zero
}

// subagentReply is a get_subagent_messages answer as the server's reader
// gives one: the window's entries, and the messages of its message entries.
func subagentReply(t *testing.T, file string, fromByte, nextByte int, texts ...string) string {
	t.Helper()
	var messages []string
	for _, text := range texts {
		entry := object(t, text)
		if kind, _ := rawString(entry["type"]); kind == "message" {
			messages = append(messages, string(entry["message"]))
		}
	}
	return fmt.Sprintf(`{"sessionFile":%q,"fromByte":%d,"nextByte":%d,"reset":false,"entries":[%s],"messages":[%s]}`,
		file, fromByte, nextByte, strings.Join(texts, ","), strings.Join(messages, ","))
}

// A subagent transcript is read in windows: a record that an elide pass
// appends lands in a later window than the tool result it shortens. If this
// regresses, a host polling the transcript keeps the heavy result, and lists
// the record as an entry.
func TestGetSubagentMessagesReturnsThePatchOfALaterRecord(t *testing.T) {
	c, s := startFake(t, readyV1, nil)
	ctx := context.Background()
	read := func(file string, fromByte *int64) func() (SubagentTranscriptRead, error) {
		return func() (SubagentTranscriptRead, error) {
			return c.GetSubagentMessages(ctx, GetSubagentMessagesCommand{SessionFile: &file, FromByte: fromByte})
		}
	}
	first := answered(t, s, subagentReply(t, "/s.jsonl", 0, 100,
		userEntry("u1", "", "list"), toolResultEntry("t1", "u1", heavyContent)), read("/s.jsonl", nil))
	second := answered(t, s, subagentReply(t, "/s.jsonl", 100, 200,
		recordEntry("p1", "t1", `[{"entryId":"t1","message":{"content":`+elidedContent+`}}]`),
		userEntry("u2", "p1", "thanks")), read("/s.jsonl", Ptr(first.NextByte)))
	// Control: the same transcript with the field written inline.
	inline := answered(t, s, subagentReply(t, "/inline.jsonl", 0, 200,
		userEntry("u1", "", "list"), toolResultEntry("t1", "u1", elidedContent), userEntry("u2", "t1", "thanks")),
		read("/inline.jsonl", nil))
	// What a caller that holds the earlier entries does with the patches.
	for _, patch := range second.EntryPatches {
		for _, entry := range first.Entries {
			if id, _ := rawString(entry["id"]); id == patch.EntryID && EntryAcceptsPatch(entry, patch) {
				SetPatchedFields(entry, patch)
			}
		}
	}

	assertSameJSON(t, second.EntryPatches, []any{map[string]any{"entryId": "t1", "message": map[string]any{"content": json.RawMessage(elidedContent)}}})
	if len(second.Entries) != 1 || string(second.Entries[0]["parentId"]) != `"t1"` || len(second.Messages) != 1 {
		t.Fatalf("second reply: %+v", second.SubagentMessages)
	}
	// The patched entry reads as the inline file's.
	assertSameJSON(t, first.Entries, inline.Entries[:2])
	if len(inline.EntryPatches) != 0 {
		t.Fatalf("inline patches %+v", inline.EntryPatches)
	}
}

// The records of one reply apply to its entries whatever the server did, and
// only a patch whose target the reply lacks comes back.
func TestGetSubagentMessagesAppliesARecordWithinItsReply(t *testing.T) {
	c, s := startFake(t, readyV1, nil)
	read := answered(t, s, subagentReply(t, "/s.jsonl", 100, 200,
		assistantEntry("a1", "a0", ""),
		toolResultEntry("t1", "a1", heavyContent),
		recordEntry("p1", "t1", `[{"entryId":"t1","message":{"content":`+elidedContent+`}},{"entryId":"a0","message":{"elidedOutputTokens":9}}]`),
	), func() (SubagentTranscriptRead, error) {
		return c.GetSubagentMessages(context.Background(), GetSubagentMessagesCommand{SessionFile: Ptr("/s.jsonl"), FromByte: Ptr[int64](100)})
	})
	if len(read.Entries) != 2 || len(read.Messages) != 2 {
		t.Fatalf("reply: %+v", read.SubagentMessages)
	}
	result, ok := read.Messages[1].Value.(ToolResultMessage)
	if !ok {
		t.Fatalf("message %T", read.Messages[1].Value)
	}
	assertSameJSON(t, result.Content, json.RawMessage(elidedContent))
	assertSameJSON(t, read.EntryPatches, []any{map[string]any{"entryId": "a0", "message": map[string]any{"elidedOutputTokens": 9}}})
}

// A host that mirrors the session with GetEntries(Since) or GetTree sees each
// record as an entry, and an entry after it whose parent is no entry it lists.
// The server's live entries already carry each record; a record it holds can
// keep a value a later rewrite-only pass replaced in its entry, so applying it
// again would bring that value back.
func TestGetEntriesAndGetTreeListNoRecordAndApplyNoneAgain(t *testing.T) {
	c, s := startFake(t, readyV1, nil)
	ctx := context.Background()
	withImage := `[{"entryId":"t1","message":{"content":[{"type":"text","text":"[elided: see artifact://1]"},{"type":"image","data":"aGVsbG8=","mimeType":"image/png"}]}}]`
	record := recordEntry("p1", "t1", withImage)
	whole := answered(t, s, fmt.Sprintf(`{"entries":[%s],"leafId":"p2"}`, strings.Join([]string{
		userEntry("u1", "", "go"), toolResultEntry("t1", "u1", elidedContent), record,
		userEntry("u2", "p1", "thanks"), recordEntry("p2", "u2", "[]"),
	}, ",")), func() (SessionEntries, error) { return c.GetEntries(ctx, GetEntriesCommand{}) })
	since := answered(t, s, fmt.Sprintf(`{"entries":[%s],"leafId":"u3"}`, userEntry("u3", "p2", "more")),
		func() (SessionEntries, error) { return c.GetEntries(ctx, GetEntriesCommand{Since: Ptr("u2")}) })
	node := func(entry string, children ...string) string {
		return fmt.Sprintf(`{"entry":%s,"children":[%s]}`, entry, strings.Join(children, ","))
	}
	tree := answered(t, s, fmt.Sprintf(`{"tree":[%s],"leafId":"p2"}`,
		node(userEntry("u1", "", "go"), node(toolResultEntry("t1", "u1", elidedContent),
			node(record, node(userEntry("u2", "p1", "thanks"), node(recordEntry("p2", "u2", "[]"))))))),
		func() (SessionTree, error) { return c.GetTree(ctx) })

	var ids [][2]string
	for _, entry := range append(whole.Entries, since.Entries...) {
		id, _ := rawString(entry["id"])
		ids = append(ids, [2]string{id, string(entry["parentId"])})
	}
	if want := [][2]string{{"u1", "null"}, {"t1", `"u1"`}, {"u2", `"t1"`}, {"u3", `"u2"`}}; !reflect.DeepEqual(ids, want) {
		t.Fatalf("entries %v", ids)
	}
	if whole.LeafID == nil || *whole.LeafID != "u2" || tree.LeafID == nil || *tree.LeafID != "u2" {
		t.Fatalf("leaves %v %v", whole.LeafID, tree.LeafID)
	}
	assertSameJSON(t, messageMember(t, whole.Entries[1], "content"), json.RawMessage(elidedContent))
	want := []any{[]any{"u1", "null", []any{[]any{"t1", `"u1"`, []any{[]any{"u2", `"t1"`, []any(nil)}}}}}}
	if got := shape(t, tree.Tree); !reflect.DeepEqual(got, want) {
		t.Fatalf("tree %v", got)
	}
}
