package omprpc

// `entry_patch` records of a session transcript, as every reader of the file
// applies them: a port of packages/utils/src/entry-patches.ts, the rules the
// omp readers share. A change to the rules changes both.
//
// A pass that changes an entry after its line is written (a retry saga's
// marker, a compaction's dead-end `warning` or corrected `tokensAfter`, a
// snapcompact archive, an elide pass's placeholders) appends one `custom`
// entry with `customType` EntryPatchCustomType that names entries already in
// the file and the fields to set on them, instead of rewriting the file. The
// original lines stay, so a reader that shows or derives anything from those
// fields applies the records first: over the entries of a whole transcript or
// of one window of it, ApplyEntryPatches; over entries it read and kept
// earlier, EntryPatchesOf on each later record, then EntryAcceptsPatch and
// SetPatchedFields on the kept entry the patch names, in file order. Records
// apply in file order, so the newest value of a field wins, and applying them
// again changes nothing. Entries are raw JSON objects, changed in place.

import (
	"bytes"
	"encoding/json"
	"maps"
	"slices"
	"strconv"
)

// EntryPatchCustomType is the `customType` of an `entry_patch` record.
const EntryPatchCustomType = "entry_patch"

// EntryPatch is one patch of an `entry_patch` record: the id of the entry it
// changes, and the fields it sets on that entry (Entry, nil when the patch
// has no `entry`) and on a `message` entry's message (Message, nil when the
// patch has no `message`), each as raw JSON.
type EntryPatch struct {
	EntryID string                     `json:"entryId"`
	Entry   map[string]json.RawMessage `json:"entry,omitempty"`
	Message map[string]json.RawMessage `json:"message,omitempty"`
}

// EntryPatchSkipReason says why a reader left a record, or one patch of it,
// unapplied.
type EntryPatchSkipReason string

const (
	// EntryPatchMalformed: the record's `data` is not a list of patches of the
	// fields a patch may set; a text block without a string `text`, an image
	// block without string `data`, and a counter that is not a finite number
	// make it so.
	EntryPatchMalformed EntryPatchSkipReason = "malformed"
	// EntryPatchMissingTarget: no entry has the id the patch names.
	EntryPatchMissingTarget EntryPatchSkipReason = "missing-target"
	// EntryPatchMisfit: the patch names a field its target's kind or role
	// lacks, or `content` of another shape.
	EntryPatchMisfit EntryPatchSkipReason = "misfit"
)

// EntryPatchSkip is a record, or one patch of it, a reader left unapplied.
// EntryID is empty for a malformed record.
type EntryPatchSkip struct {
	Reason   EntryPatchSkipReason
	RecordID string
	EntryID  string
}

var (
	compactionPatchFields = []string{"warning", "tokensAfter", "preserveData"}
	assistantPatchFields  = []string{"retryRecovery", "continued", "contextSnapshot", "elidedOutputTokens"}
	// Message roles whose `content` an elide pass shortens, each with whether
	// that `content` may be a string; assistant and tool-result `content` is
	// always a list of blocks.
	contentTakesString = map[string]bool{"user": true, "developer": true, "assistant": false, "toolResult": false}
)

// rawString is the string data holds, if it holds one.
func rawString(data json.RawMessage) (string, bool) {
	var value string
	if jsonKind(data) != '"' || json.Unmarshal(data, &value) != nil {
		return "", false
	}
	return value, true
}

// rawObject is the members of the object data holds, if it holds one.
func rawObject(data json.RawMessage) (map[string]json.RawMessage, bool) {
	if jsonKind(data) != '{' {
		return nil, false
	}
	members, err := decodeObject(data, "")
	return members, err == nil
}

func isTrue(data json.RawMessage) bool {
	return string(bytes.TrimSpace(data)) == "true"
}

// isContentBlock reports whether data holds a content block a message can
// hold: a string `type`, and the payload a text or image block carries
// (`text`, `data`) as a string, so a provider request built from it never
// meets a block without its payload.
func isContentBlock(data json.RawMessage) bool {
	members, ok := rawObject(data)
	if !ok {
		return false
	}
	kind, ok := rawString(members["type"])
	switch {
	case !ok:
		return false
	case kind == "text":
		return jsonKind(members["text"]) == '"'
	case kind == "image":
		return jsonKind(members["data"]) == '"'
	}
	return true
}

func isRawContent(data json.RawMessage) bool {
	switch jsonKind(data) {
	case '"':
		return true
	case '[':
		blocks, err := splitArray(data)
		if err != nil {
			return false
		}
		for _, block := range blocks {
			if !isContentBlock(block) {
				return false
			}
		}
		return true
	}
	return false
}

// isCount reports whether data holds a finite number, as every counter a
// patch sets is: `JSON.parse` reads a number past the float64 range (1e400)
// as Infinity, which ParseFloat refuses.
func isCount(data json.RawMessage) bool {
	if jsonKind(data) != '0' {
		return false
	}
	_, err := strconv.ParseFloat(string(bytes.TrimSpace(data)), 64)
	return err == nil
}

// fieldsOf is the object data holds when each field check names accepts the
// field's value or the field is absent.
func fieldsOf(data json.RawMessage, checks map[string]func(json.RawMessage) bool) (map[string]json.RawMessage, bool) {
	fields, ok := rawObject(data)
	if !ok {
		return nil, false
	}
	for key, check := range checks {
		if value, present := fields[key]; present && !check(value) {
			return nil, false
		}
	}
	return fields, true
}

func kindIs(kind byte) func(json.RawMessage) bool {
	return func(data json.RawMessage) bool { return jsonKind(data) == kind }
}

var (
	entryFieldChecks = map[string]func(json.RawMessage) bool{
		"warning":      kindIs('"'),
		"tokensAfter":  isCount,
		"preserveData": kindIs('{'),
		"content":      isRawContent,
	}
	messageFieldChecks = map[string]func(json.RawMessage) bool{
		"retryRecovery":      kindIs('{'),
		"continued":          isTrue,
		"contextSnapshot":    kindIs('{'),
		"elidedOutputTokens": isCount,
		"prunedAt":           isCount,
		"content":            isRawContent,
	}
)

// parseEntryPatch reads one patch of a record's `data.patches`.
func parseEntryPatch(data json.RawMessage) (EntryPatch, bool) {
	members, ok := rawObject(data)
	if !ok {
		return EntryPatch{}, false
	}
	entryID, ok := rawString(members["entryId"])
	if !ok {
		return EntryPatch{}, false
	}
	patch := EntryPatch{EntryID: entryID}
	if value, present := members["entry"]; present {
		if patch.Entry, ok = fieldsOf(value, entryFieldChecks); !ok {
			return EntryPatch{}, false
		}
	}
	if value, present := members["message"]; present {
		if patch.Message, ok = fieldsOf(value, messageFieldChecks); !ok {
			return EntryPatch{}, false
		}
	}
	return patch, true
}

// IsEntryPatchRecord reports whether entry is an `entry_patch` record.
func IsEntryPatchRecord(entry map[string]json.RawMessage) bool {
	kind, _ := rawString(entry["type"])
	customType, _ := rawString(entry["customType"])
	return kind == "custom" && customType == EntryPatchCustomType
}

// EntryPatchesOf returns the patches of record; ok is false when its `data`
// is malformed.
func EntryPatchesOf(record map[string]json.RawMessage) (patches []EntryPatch, ok bool) {
	data, ok := rawObject(record["data"])
	if !ok || jsonKind(data["patches"]) != '[' {
		return nil, false
	}
	items, err := splitArray(data["patches"])
	if err != nil {
		return nil, false
	}
	patches = make([]EntryPatch, 0, len(items))
	for _, item := range items {
		patch, ok := parseEntryPatch(item)
		if !ok {
			return nil, false
		}
		patches = append(patches, patch)
	}
	return patches, true
}

func hasAny(fields map[string]json.RawMessage, keys []string) bool {
	for _, key := range keys {
		if _, present := fields[key]; present {
			return true
		}
	}
	return false
}

// EntryAcceptsPatch reports whether every field patch names exists on
// entry's kind, with a `content` of the shape its role holds.
func EntryAcceptsPatch(entry map[string]json.RawMessage, patch EntryPatch) bool {
	kind, _ := rawString(entry["type"])
	if patch.Entry != nil {
		if hasAny(patch.Entry, compactionPatchFields) && kind != "compaction" {
			return false
		}
		if _, present := patch.Entry["content"]; present && kind != "custom_message" {
			return false
		}
	}
	if patch.Message == nil {
		return true
	}
	message, ok := rawObject(entry["message"])
	if kind != "message" || !ok {
		return false
	}
	role, _ := rawString(message["role"])
	if hasAny(patch.Message, assistantPatchFields) && role != "assistant" {
		return false
	}
	if _, present := patch.Message["prunedAt"]; present && role != "toolResult" {
		return false
	}
	content, present := patch.Message["content"]
	if !present {
		return true
	}
	takesString, known := contentTakesString[role]
	return known && (takesString || jsonKind(content) != '"')
}

// SetPatchedFields sets patch's fields on entry, which EntryAcceptsPatch
// accepted. Each value is a copy of the record's bytes. A message the patch
// changes is written again with its members in key order.
func SetPatchedFields(entry map[string]json.RawMessage, patch EntryPatch) {
	kind, _ := rawString(entry["type"])
	if patch.Entry != nil {
		if kind == "compaction" {
			for _, key := range compactionPatchFields {
				if value, present := patch.Entry[key]; present {
					entry[key] = bytes.Clone(value)
				}
			}
		}
		if value, present := patch.Entry["content"]; present && kind == "custom_message" {
			entry["content"] = bytes.Clone(value)
		}
	}
	if patch.Message == nil || kind != "message" {
		return
	}
	message, ok := rawObject(entry["message"])
	if !ok {
		return
	}
	role, _ := rawString(message["role"])
	changed := false
	set := func(key string) {
		if value, present := patch.Message[key]; present {
			message[key] = bytes.Clone(value)
			changed = true
		}
	}
	if role == "assistant" {
		for _, key := range assistantPatchFields {
			set(key)
		}
	}
	if role == "toolResult" {
		set("prunedAt")
	}
	if _, holds := message["content"]; holds {
		set("content")
	}
	if changed {
		entry["message"] = encodeRawObject(message)
	}
}

// targetIDOf is the id under which entry is a patch target: every entry but
// the session header has one.
func targetIDOf(entry map[string]json.RawMessage) (string, bool) {
	if kind, _ := rawString(entry["type"]); kind == "session" {
		return "", false
	}
	return rawString(entry["id"])
}

// ApplyEntryPatches sets, in place, every field an `entry_patch` record in
// entries names on the entry with that id among entries. Records apply in
// file order, so the newest value of a field wins, and applying them again
// changes nothing. A record may precede its target. A malformed record, or a
// patch whose target is missing, lacks a field it names, or holds `content`
// of another shape, is skipped and reported to onSkip (which may be nil).
// It reports whether any field was set.
func ApplyEntryPatches(entries []map[string]json.RawMessage, onSkip func(EntryPatchSkip)) bool {
	skip := func(s EntryPatchSkip) {
		if onSkip != nil {
			onSkip(s)
		}
	}
	var byID map[string]map[string]json.RawMessage
	changed := false
	for _, entry := range entries {
		if !IsEntryPatchRecord(entry) {
			continue
		}
		recordID, _ := rawString(entry["id"])
		patches, ok := EntryPatchesOf(entry)
		if !ok {
			skip(EntryPatchSkip{Reason: EntryPatchMalformed, RecordID: recordID})
			continue
		}
		if byID == nil {
			byID = make(map[string]map[string]json.RawMessage, len(entries))
			for _, held := range entries {
				if id, ok := targetIDOf(held); ok {
					byID[id] = held
				}
			}
		}
		for _, patch := range patches {
			target, ok := byID[patch.EntryID]
			if !ok {
				skip(EntryPatchSkip{Reason: EntryPatchMissingTarget, RecordID: recordID, EntryID: patch.EntryID})
				continue
			}
			if !EntryAcceptsPatch(target, patch) {
				skip(EntryPatchSkip{Reason: EntryPatchMisfit, RecordID: recordID, EntryID: patch.EntryID})
				continue
			}
			SetPatchedFields(target, patch)
			changed = true
		}
	}
	return changed
}

// encodeRawObject writes members as one JSON object, keys in order, each
// value verbatim, so a value of any depth is written whole.
func encodeRawObject(members map[string]json.RawMessage) json.RawMessage {
	var out bytes.Buffer
	out.WriteByte('{')
	for index, key := range slices.Sorted(maps.Keys(members)) {
		if index > 0 {
			out.WriteByte(',')
		}
		name, _ := json.Marshal(key)
		out.Write(name)
		out.WriteByte(':')
		if value := members[key]; len(value) > 0 {
			out.Write(value)
		} else {
			out.WriteString("null")
		}
	}
	out.WriteByte('}')
	return out.Bytes()
}

// recordParents holds each `entry_patch` record a reader read, by id, with
// its parent past records: nil for a record at the root.
type recordParents map[string]*string

// pastRecords is the entry that takes the place of id once the records are
// left out: id itself, or the parent of the record it names.
func pastRecords(id *string, parents recordParents) *string {
	if id == nil {
		return nil
	}
	if parent, isRecord := parents[*id]; isRecord {
		return parent
	}
	return id
}

func rawEntryID(id *string) json.RawMessage {
	if id == nil {
		return json.RawMessage("null")
	}
	encoded, _ := json.Marshal(*id)
	return encoded
}

func parentIDOf(entry map[string]json.RawMessage) *string {
	if parent, ok := rawString(entry["parentId"]); ok {
		return &parent
	}
	return nil
}

// noteRecord adds record, an `entry_patch` record whose parent is already
// past records, to parents.
func noteRecord(record map[string]json.RawMessage, parents recordParents) {
	if id, ok := rawString(record["id"]); ok {
		parents[id] = parentIDOf(record)
	}
}

// entriesPastRecords returns entries, in file order, without their
// `entry_patch` records; an entry whose parent is a record takes the record's
// parent. It adds each record to parents, which holds the records of earlier
// reads of the same transcript.
func entriesPastRecords(entries []map[string]json.RawMessage, parents recordParents) []map[string]json.RawMessage {
	kept := entries[:0:0]
	for _, entry := range entries {
		if kind, _ := rawString(entry["type"]); kind != "session" {
			if parent := parentIDOf(entry); parent != nil {
				if past, isRecord := parents[*parent]; isRecord {
					entry["parentId"] = rawEntryID(past)
				}
			}
			if IsEntryPatchRecord(entry) {
				noteRecord(entry, parents)
				continue
			}
		}
		kept = append(kept, entry)
	}
	return kept
}

// treeNode is one node of a get_tree answer: its entry, its other members,
// and its children, by index among the nodes read.
type treeNode struct {
	entry    json.RawMessage
	members  []treeMember
	children []int
}

type treeMember struct {
	key   string
	value json.RawMessage
}

// treeReadFrame is a container readTreeNodes is inside: an array of nodes
// (the children of node, or the top array when node is -1) or a node object.
type treeReadFrame struct {
	array bool
	node  int
	list  []int
}

// readTreeNodes reads the JSON array data of tree nodes, however deep it
// nests, in one pass: it appends each node to nodes, and returns the indexes
// of the array's own nodes. Values other than `children` keep data's bytes.
func readTreeNodes(data []byte, nodes *[]treeNode) ([]int, error) {
	i := skipSpace(data, 0)
	if byteAt(data, i) != '[' {
		return nil, errInvalidJSON
	}
	i = skipSpace(data, i+1)
	if byteAt(data, i) == ']' {
		return nil, endOfInput(data, i+1)
	}
	stack := []treeReadFrame{{array: true, node: -1}}
	// Whether a value of the innermost container just ended.
	afterValue := false
	for {
		i = skipSpace(data, i)
		top := len(stack) - 1
		c := byteAt(data, i)
		switch {
		case afterValue && c == ',':
			i++
			afterValue = false
		case afterValue && stack[top].array && c == ']':
			i++
			frame := stack[top]
			stack = stack[:top]
			if frame.node < 0 {
				return frame.list, endOfInput(data, i)
			}
			(*nodes)[frame.node].children = frame.list
		case afterValue && !stack[top].array && c == '}':
			i++
			stack = stack[:top]
		case afterValue:
			return nil, errInvalidJSON
		case stack[top].array:
			// A node starts.
			if c != '{' {
				return nil, errInvalidJSON
			}
			index := len(*nodes)
			*nodes = append(*nodes, treeNode{})
			stack[top].list = append(stack[top].list, index)
			if i = skipSpace(data, i+1); byteAt(data, i) == '}' {
				i++
				afterValue = true
				continue
			}
			stack = append(stack, treeReadFrame{node: index})
		default:
			// A member of the node at the top starts.
			keyEnd, err := scanString(data, i)
			if err != nil {
				return nil, err
			}
			var key string
			if err := json.Unmarshal(data[i:keyEnd], &key); err != nil {
				return nil, err
			}
			start, err := scanKey(data, i)
			if err != nil {
				return nil, err
			}
			node := stack[top].node
			if key == "children" {
				if byteAt(data, start) != '[' {
					return nil, errInvalidJSON
				}
				if i = skipSpace(data, start+1); byteAt(data, i) == ']' {
					i++
					afterValue = true
					continue
				}
				stack = append(stack, treeReadFrame{array: true, node: node})
				continue
			}
			end, err := scanValue(data, start)
			if err != nil {
				return nil, err
			}
			if key == "entry" {
				(*nodes)[node].entry = data[start:end]
			} else {
				(*nodes)[node].members = append((*nodes)[node].members, treeMember{key: key, value: data[start:end]})
			}
			i = end
			afterValue = true
		}
	}
}

// spliceEntry returns entry with its parent set to parent when relink, and
// whether it is an `entry_patch` record; a record is added to parents and its
// parent returned.
func spliceEntry(entry json.RawMessage, relink bool, parent *string, parents recordParents) (json.RawMessage, bool, *string) {
	fields, ok := rawObject(entry)
	if !ok {
		return entry, false, nil
	}
	if relink {
		fields["parentId"] = rawEntryID(parent)
		entry = encodeRawObject(fields)
	}
	if !IsEntryPatchRecord(fields) {
		return entry, false, nil
	}
	noteRecord(fields, parents)
	return entry, true, parentIDOf(fields)
}

// treeWriteFrame is a list of nodes writeTreeNodes writes: the children of a
// kept node (closes, which closes their array and the node after them), or
// of a record, whose children take its place in the array being written.
type treeWriteFrame struct {
	items  []int
	pos    int
	relink bool
	parent *string
	first  *bool
	closes bool
	tail   []treeMember
}

// writeTreeNodes writes the nodes at items as a JSON array of tree nodes,
// without their record nodes, with a stack of its own.
func writeTreeNodes(out *bytes.Buffer, nodes []treeNode, items []int, parents recordParents) {
	out.WriteByte('[')
	first := true
	stack := []treeWriteFrame{{items: items, first: &first}}
	for len(stack) > 0 {
		top := &stack[len(stack)-1]
		if top.pos == len(top.items) {
			frame := *top
			stack = stack[:len(stack)-1]
			if frame.closes {
				out.WriteByte(']')
				for _, member := range frame.tail {
					name, _ := json.Marshal(member.key)
					out.WriteByte(',')
					out.Write(name)
					out.WriteByte(':')
					out.Write(member.value)
				}
				out.WriteByte('}')
			}
			continue
		}
		node := nodes[top.items[top.pos]]
		top.pos++
		entry, isRecord, recordParent := spliceEntry(node.entry, top.relink, top.parent, parents)
		if isRecord {
			stack = append(stack, treeWriteFrame{items: node.children, relink: true, parent: recordParent, first: top.first})
			continue
		}
		if !*top.first {
			out.WriteByte(',')
		}
		*top.first = false
		out.WriteString(`{"entry":`)
		if len(entry) == 0 {
			entry = json.RawMessage("null")
		}
		out.Write(entry)
		out.WriteString(`,"children":[`)
		childFirst := true
		stack = append(stack, treeWriteFrame{items: node.children, first: &childFirst, closes: true, tail: node.members})
	}
	out.WriteByte(']')
}

// treeRootFrame is a list of root nodes treePastRecords keeps, the children
// of a root record among them.
type treeRootFrame struct {
	items  []int
	pos    int
	relink bool
	parent *string
}

// treePastRecords returns roots, the nodes of a get_tree answer, without their
// `entry_patch` record nodes: the children of a record node take its place
// among its parent's children, and its parent as their entries' parent. It
// adds each record to parents. It reads each root's `children` once and
// writes it once, however deep the tree nests.
func treePastRecords(roots []map[string]json.RawMessage, parents recordParents) ([]map[string]json.RawMessage, error) {
	var nodes []treeNode
	rootItems := make([]int, 0, len(roots))
	for _, root := range roots {
		node := treeNode{entry: root["entry"]}
		for _, key := range slices.Sorted(maps.Keys(root)) {
			if key != "entry" && key != "children" {
				node.members = append(node.members, treeMember{key: key, value: root[key]})
			}
		}
		if children, present := root["children"]; present && !isNull(children) {
			read, err := readTreeNodes(children, &nodes)
			if err != nil {
				return nil, err
			}
			node.children = read
		}
		rootItems = append(rootItems, len(nodes))
		nodes = append(nodes, node)
	}
	kept := make([]map[string]json.RawMessage, 0, len(roots))
	stack := []treeRootFrame{{items: rootItems}}
	for len(stack) > 0 {
		top := &stack[len(stack)-1]
		if top.pos == len(top.items) {
			stack = stack[:len(stack)-1]
			continue
		}
		node := nodes[top.items[top.pos]]
		top.pos++
		entry, isRecord, recordParent := spliceEntry(node.entry, top.relink, top.parent, parents)
		if isRecord {
			stack = append(stack, treeRootFrame{items: node.children, relink: true, parent: recordParent})
			continue
		}
		root := make(map[string]json.RawMessage, len(node.members)+2)
		for _, member := range node.members {
			root[member.key] = member.value
		}
		root["entry"] = entry
		var children bytes.Buffer
		writeTreeNodes(&children, nodes, node.children, parents)
		root["children"] = children.Bytes()
		kept = append(kept, root)
	}
	return kept, nil
}
