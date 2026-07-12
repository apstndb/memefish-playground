// Package bridge implements the host-independent memefish playground protocol.
package bridge

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"reflect"
	"strings"

	"github.com/cloudspannerecosystem/memefish"
	"github.com/cloudspannerecosystem/memefish/ast"
	"github.com/k0kubun/pp/v3"
)

const (
	// ProtocolVersion is the JSON bridge protocol implemented by this package.
	ProtocolVersion = 2

	// MaxSourceBytes is the largest source accepted by a parse request.
	MaxSourceBytes = 1 << 20

	// MaxGoPrettyBytes is the largest raw Go pretty-print string returned for
	// one result. JSON escaping can make the encoded response larger.
	MaxGoPrettyBytes = 1 << 20

	// maxGoPrettyDepth renders the documented Spanner nesting boundaries that
	// require the deepest pp output: 75 function calls need about 230 levels
	// and 60 subselects need about 245. Bare parentheses have no documented
	// service limit, so deeper values are disclosed as depth-limited.
	maxGoPrettyDepth = 256

	// maxGoPrettyWork bounds reflection work before invoking pp. Calibration
	// units (visited values * deepest visited level) are approximately:
	// ABS x75=146K, parentheses x1000=108K, IN x10000=375, and 500
	// depth-100 select items=53M.
	maxGoPrettyWork = 1_500_000
)

const (
	goPrettyReset            = "\x1b[0m"
	goPrettyTruncationMarker = goPrettyReset +
		"\n// Go pretty output truncated at the 1 MiB display limit.\n"
)

var errUnknownMode = errors.New("unknown parser mode")
var errUnsupportedMode = errors.New("parser mode is not supported by this memefish version")

// Engine identifies the memefish build serving a request.
type Engine struct {
	Channel   string `json:"channel"`
	Version   string `json:"version"`
	Commit    string `json:"commit"`
	GoVersion string `json:"goVersion"`
}

// Request is a protocol version 2 parse request.
type Request struct {
	ProtocolVersion int    `json:"protocolVersion"`
	ID              string `json:"id"`
	Mode            string `json:"mode"`
	Source          string `json:"source"`
	GoPrettyIndex   *int   `json:"goPrettyIndex,omitempty"`
}

// Response is a protocol version 2 parse response.
type Response struct {
	ProtocolVersion int          `json:"protocolVersion"`
	ID              string       `json:"id"`
	OK              bool         `json:"ok"`
	Engine          Engine       `json:"engine"`
	Results         []Result     `json:"results"`
	Diagnostics     []Diagnostic `json:"diagnostics"`
	Fatal           *Fatal       `json:"fatal"`
}

// Result describes one parsed AST root.
type Result struct {
	NodeType             string       `json:"nodeType"`
	Range                SourceRange  `json:"range"`
	SQL                  string       `json:"sql"`
	GoPretty             string       `json:"goPretty,omitempty"`
	GoPrettyDepthLimited bool         `json:"goPrettyDepthLimited,omitempty"`
	GoPrettyTruncated    bool         `json:"goPrettyTruncated,omitempty"`
	GoPrettyRefused      bool         `json:"goPrettyRefused,omitempty"`
	AST                  ProjectedAST `json:"ast"`
}

// Diagnostic describes a recoverable parser error.
type Diagnostic struct {
	Message string      `json:"message"`
	Range   SourceRange `json:"range"`
}

// Fatal describes a bridge failure for which no parse result is available.
type Fatal struct {
	Kind    string `json:"kind"`
	Message string `json:"message"`
}

// SourceRange carries both memefish UTF-8 byte offsets and JavaScript UTF-16
// code-unit offsets.
type SourceRange struct {
	StartByte int `json:"startByte"`
	EndByte   int `json:"endByte"`
	From      int `json:"from"`
	To        int `json:"to"`
}

// ProjectedAST is a reflection-based display form of a memefish AST value.
// It is not a stable serialization format.
type ProjectedAST struct {
	Type string `json:"type"`
	// Range is present only when the projected value is an AST node with valid
	// source bounds.
	Range  *SourceRange   `json:"range,omitempty"`
	Fields map[string]any `json:"fields"`
}

// Handler parses protocol requests using one immutable engine identity.
type Handler struct {
	engine Engine
}

// NewHandler constructs a Handler for one memefish engine build.
func NewHandler(engine Engine) *Handler {
	return &Handler{engine: engine}
}

// Engine returns the engine identity included in every response.
func (h *Handler) Engine() Engine {
	return h.engine
}

// ReadyJSON returns the Worker ready notification as a JSON string.
func (h *Handler) ReadyJSON() (string, error) {
	message := struct {
		Type            string `json:"type"`
		ProtocolVersion int    `json:"protocolVersion"`
		Engine          Engine `json:"engine"`
	}{
		Type:            "ready",
		ProtocolVersion: ProtocolVersion,
		Engine:          h.engine,
	}

	encoded, err := json.Marshal(message)
	if err != nil {
		return "", fmt.Errorf("encoding ready message: %w", err)
	}
	return string(encoded), nil
}

// Handle accepts one request JSON string and returns one response JSON string.
// Panics are contained per request so a malformed input cannot terminate the
// long-lived Web Worker.
func (h *Handler) Handle(requestJSON string) (responseJSON string) {
	response := h.newResponse("")
	defer func() {
		if recovered := recover(); recovered != nil {
			response = h.fatalResponse(
				response.ID,
				"parser_panic",
				fmt.Sprintf("parser panicked: %v", recovered),
			)
			responseJSON = h.encodeResponse(response)
		}
	}()

	request, err := decodeRequest(requestJSON)
	response.ID = request.ID
	if err != nil {
		return h.encodeResponse(h.fatalResponse(
			request.ID,
			"invalid_request",
			fmt.Sprintf("invalid request JSON: %v", err),
		))
	}
	if request.ProtocolVersion != ProtocolVersion {
		return h.encodeResponse(h.fatalResponse(
			request.ID,
			"invalid_request",
			fmt.Sprintf("unsupported protocol version: %d", request.ProtocolVersion),
		))
	}
	if request.ID == "" {
		return h.encodeResponse(h.fatalResponse(
			request.ID,
			"invalid_request",
			"request id must not be empty",
		))
	}
	if len(request.Source) > MaxSourceBytes {
		return h.encodeResponse(h.fatalResponse(
			request.ID,
			"invalid_request",
			fmt.Sprintf("source exceeds %d-byte limit", MaxSourceBytes),
		))
	}
	if request.GoPrettyIndex != nil && *request.GoPrettyIndex < 0 {
		return h.encodeResponse(h.fatalResponse(
			request.ID,
			"invalid_request",
			"go pretty index must not be negative",
		))
	}

	nodes, parseErr := parse(request.Mode, request.Source)
	if errors.Is(parseErr, errUnknownMode) {
		return h.encodeResponse(h.fatalResponse(
			request.ID,
			"invalid_request",
			fmt.Sprintf("unknown parser mode: %q", request.Mode),
		))
	}
	if errors.Is(parseErr, errUnsupportedMode) {
		return h.encodeResponse(h.fatalResponse(
			request.ID,
			"invalid_request",
			fmt.Sprintf("parser mode %q is not supported by %s", request.Mode, h.engine.Version),
		))
	}
	if request.GoPrettyIndex != nil && len(nodes) > 0 && *request.GoPrettyIndex >= len(nodes) {
		return h.encodeResponse(h.fatalResponse(
			request.ID,
			"invalid_request",
			fmt.Sprintf(
				"go pretty index %d is out of range for %d results",
				*request.GoPrettyIndex,
				len(nodes),
			),
		))
	}

	sourceIndex := newSourceIndex(request.Source)
	response.Results = makeResults(sourceIndex, nodes, request.GoPrettyIndex)
	response.Diagnostics = makeDiagnostics(sourceIndex, parseErr)
	response.OK = parseErr == nil
	return h.encodeResponse(response)
}

func decodeRequest(requestJSON string) (Request, error) {
	decoder := json.NewDecoder(strings.NewReader(requestJSON))
	decoder.DisallowUnknownFields()

	var request Request
	if err := decoder.Decode(&request); err != nil {
		return request, fmt.Errorf("decoding request: %w", err)
	}

	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return request, errors.New("decoding request: multiple JSON values")
		}
		return request, fmt.Errorf("decoding trailing request data: %w", err)
	}
	return request, nil
}

func parse(mode, source string) ([]ast.Node, error) {
	switch mode {
	case "statement":
		node, err := memefish.ParseStatement("", source)
		return collectNode(node), err
	case "statements":
		nodes, err := memefish.ParseStatements("", source)
		return collectNodes(nodes), err
	case "query":
		node, err := memefish.ParseQuery("", source)
		return collectNode(node), err
	case "expr":
		node, err := memefish.ParseExpr("", source)
		return collectNode(node), err
	case "type":
		node, err := memefish.ParseType("", source)
		return collectNode(node), err
	case "schemaType":
		node, err := parseSchemaType(source)
		return collectNode(node), err
	case "ddl":
		node, err := memefish.ParseDDL("", source)
		return collectNode(node), err
	case "ddls":
		nodes, err := memefish.ParseDDLs("", source)
		return collectNodes(nodes), err
	case "dml":
		node, err := memefish.ParseDML("", source)
		return collectNode(node), err
	case "dmls":
		nodes, err := memefish.ParseDMLs("", source)
		return collectNodes(nodes), err
	default:
		return []ast.Node{}, errUnknownMode
	}
}

func collectNode(node ast.Node) []ast.Node {
	nodes := []ast.Node{}
	if validNode(node) {
		nodes = append(nodes, node)
	}
	return nodes
}

func collectNodes[T ast.Node](values []T) []ast.Node {
	nodes := make([]ast.Node, 0, len(values))
	for _, value := range values {
		node := ast.Node(value)
		if validNode(node) {
			nodes = append(nodes, node)
		}
	}
	return nodes
}

func validNode(node ast.Node) bool {
	if node == nil {
		return false
	}
	value := reflect.ValueOf(node)
	return value.Kind() != reflect.Pointer || !value.IsNil()
}

func makeResults(sourceIndex *sourceIndex, nodes []ast.Node, goPrettyIndex *int) []Result {
	var prettyPrinter *pp.PrettyPrinter
	if goPrettyIndex != nil && *goPrettyIndex >= 0 && *goPrettyIndex < len(nodes) {
		prettyPrinter = pp.New()
		prettyPrinter.SetColoringEnabled(true)
		prettyPrinter.SetMaxDepth(maxGoPrettyDepth)
		prettyPrinter.SetOmitEmpty(true)
	}

	results := make([]Result, 0, len(nodes))
	for index, node := range nodes {
		result := Result{
			NodeType: concreteTypeName(reflect.TypeOf(node)),
			Range:    sourceIndex.sourceRange(int(node.Pos()), int(node.End())),
			SQL:      node.SQL(),
			AST:      projectNodeWithSourceIndex(sourceIndex, node),
		}
		if prettyPrinter != nil && index == *goPrettyIndex {
			if goPrettyWorkExceedsLimit(node) {
				result.GoPrettyRefused = true
			} else {
				output := prettyPrinter.Sprint(node)
				result.GoPrettyDepthLimited = goPrettyDepthLimitReached(output)
				result.GoPretty, result.GoPrettyTruncated = boundGoPretty(output)
			}
		}
		results = append(results, result)
	}
	return results
}

type goPrettyWorkItem struct {
	value reflect.Value
	depth int
}

func goPrettyWorkExceedsLimit(node ast.Node) bool {
	stack := []goPrettyWorkItem{{value: reflect.ValueOf(node)}}
	seen := map[projectionVisit]struct{}{}
	valueCount := 0
	deepest := 0

	for len(stack) > 0 {
		item := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		value := item.value
		if !value.IsValid() || item.depth > maxGoPrettyDepth {
			continue
		}

		valueCount++
		deepest = max(deepest, item.depth)
		if valueCount > maxGoPrettyWork/max(deepest, 1) {
			return true
		}

		switch value.Kind() {
		case reflect.Interface:
			if !value.IsNil() {
				stack = append(stack, goPrettyWorkItem{
					value: value.Elem(),
					depth: item.depth + 1,
				})
			}
		case reflect.Pointer:
			if value.IsNil() {
				continue
			}
			visit := projectionVisit{typeOf: value.Type(), pointer: value.Pointer()}
			if _, ok := seen[visit]; ok {
				continue
			}
			seen[visit] = struct{}{}
			stack = append(stack, goPrettyWorkItem{
				value: value.Elem(),
				depth: item.depth + 1,
			})
		case reflect.Struct:
			valueType := value.Type()
			for index := range value.NumField() {
				fieldType := valueType.Field(index)
				field := value.Field(index)
				if fieldType.PkgPath == "" && !field.IsZero() {
					stack = append(stack, goPrettyWorkItem{
						value: field,
						depth: item.depth + 1,
					})
				}
			}
		case reflect.Slice:
			if value.Len() > pp.BufferFoldThreshold {
				continue
			}
			if !value.IsNil() {
				visit := projectionVisit{typeOf: value.Type(), pointer: value.Pointer()}
				if _, ok := seen[visit]; ok {
					continue
				}
				seen[visit] = struct{}{}
			}
			for index := range value.Len() {
				stack = append(stack, goPrettyWorkItem{
					value: value.Index(index),
					depth: item.depth + 1,
				})
			}
		case reflect.Array:
			if value.Len() > pp.BufferFoldThreshold {
				continue
			}
			for index := range value.Len() {
				stack = append(stack, goPrettyWorkItem{
					value: value.Index(index),
					depth: item.depth + 1,
				})
			}
		case reflect.Map:
			if value.IsNil() {
				continue
			}
			if value.Len() == 0 {
				continue
			}
			// pp folds large slices and arrays, but renders every map entry. Refuse
			// work that cannot fit the budget before stacking all keys and values.
			childDepth := item.depth + 1
			childLimit := maxGoPrettyWork / max(deepest, childDepth, 1)
			if valueCount > childLimit || value.Len() > (childLimit-valueCount)/2 {
				return true
			}
			visit := projectionVisit{typeOf: value.Type(), pointer: value.Pointer()}
			if _, ok := seen[visit]; ok {
				continue
			}
			seen[visit] = struct{}{}
			iterator := value.MapRange()
			for iterator.Next() {
				stack = append(
					stack,
					goPrettyWorkItem{value: iterator.Key(), depth: childDepth},
					goPrettyWorkItem{value: iterator.Value(), depth: childDepth},
				)
			}
		}
	}

	return false
}

func goPrettyDepthLimitReached(output string) bool {
	const maxIndent = maxGoPrettyDepth * 2
	for line := range strings.SplitSeq(output, "\n") {
		indent := 0
		for indent < len(line) && line[indent] == ' ' {
			indent++
		}
		if indent >= maxIndent {
			return true
		}
	}
	return false
}

func boundGoPretty(output string) (string, bool) {
	if len(output) <= MaxGoPrettyBytes {
		return output, false
	}

	// pp emits multiline struct output. Cutting on a newline cannot split a
	// UTF-8 rune or ANSI SGR sequence. Reset the style for copied terminal text
	// as well as for the browser renderer.
	prefixBudget := MaxGoPrettyBytes - len(goPrettyTruncationMarker)
	lineEnd := strings.LastIndexByte(output[:prefixBudget], '\n')
	if lineEnd < 0 {
		return goPrettyTruncationMarker, true
	}
	return output[:lineEnd+1] + goPrettyTruncationMarker, true
}

func makeDiagnostics(sourceIndex *sourceIndex, parseErr error) []Diagnostic {
	diagnostics := []Diagnostic{}
	if parseErr == nil {
		return diagnostics
	}

	var multiError memefish.MultiError
	if !errors.As(parseErr, &multiError) {
		return append(diagnostics, Diagnostic{
			Message: parseErr.Error(),
			Range:   sourceIndex.sourceRange(0, 0),
		})
	}

	for _, parserError := range multiError {
		if parserError == nil {
			continue
		}

		start, end := 0, 0
		if parserError.Position != nil {
			start = int(parserError.Position.Pos)
			end = int(parserError.Position.End)
		}
		diagnostics = append(diagnostics, Diagnostic{
			Message: parserError.Message,
			Range:   sourceIndex.sourceRange(start, end),
		})
	}
	return diagnostics
}

func (h *Handler) newResponse(id string) Response {
	return Response{
		ProtocolVersion: ProtocolVersion,
		ID:              id,
		Engine:          h.engine,
		Results:         []Result{},
		Diagnostics:     []Diagnostic{},
	}
}

func (h *Handler) fatalResponse(id, kind, message string) Response {
	response := h.newResponse(id)
	response.Fatal = &Fatal{
		Kind:    kind,
		Message: message,
	}
	return response
}

func (h *Handler) encodeResponse(response Response) string {
	encoded, err := json.Marshal(response)
	if err == nil {
		return string(encoded)
	}

	fallback := h.fatalResponse(
		response.ID,
		"encode_failure",
		fmt.Sprintf("encoding response: %v", err),
	)
	encoded, fallbackErr := json.Marshal(fallback)
	if fallbackErr == nil {
		return string(encoded)
	}

	// The fallback contains only strings, booleans, and initialized slices, so
	// encoding it cannot fail with the standard library encoder. Keep a valid
	// protocol response as a final guard against future type changes.
	return `{"protocolVersion":2,"id":"","ok":false,` +
		`"engine":{"channel":"","version":"","commit":"","goVersion":""},` +
		`"results":[],"diagnostics":[],` +
		`"fatal":{"kind":"encode_failure","message":"response encoding failed"}}`
}
