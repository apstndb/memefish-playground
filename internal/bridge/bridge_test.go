package bridge

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
)

var testEngine = Engine{
	Channel:   "release",
	Version:   "v0.8.0",
	Commit:    "0123456789abcdef",
	GoVersion: "go1.26.5",
}

func TestHandlerModes(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name          string
		mode          string
		source        string
		wantNodeTypes []string
		wantSQL       []string
	}{
		{
			name:          "statement",
			mode:          "statement",
			source:        "SELECT 1",
			wantNodeTypes: []string{"QueryStatement"},
			wantSQL:       []string{"SELECT 1"},
		},
		{
			name:          "statement GQL through public helper",
			mode:          "statement",
			source:        "GRAPH FinGraph RETURN *",
			wantNodeTypes: []string{"GQLGraphQuery"},
			wantSQL:       []string{"GRAPH FinGraph RETURN *"},
		},
		{
			name:          "statements",
			mode:          "statements",
			source:        "SELECT 1; INSERT INTO T (K) VALUES (1)",
			wantNodeTypes: []string{"QueryStatement", "Insert"},
			wantSQL:       []string{"SELECT 1", "INSERT INTO T (K) VALUES (1)"},
		},
		{
			name:          "query",
			mode:          "query",
			source:        "SELECT 1",
			wantNodeTypes: []string{"QueryStatement"},
			wantSQL:       []string{"SELECT 1"},
		},
		{
			name:          "expr",
			mode:          "expr",
			source:        "1 + 2",
			wantNodeTypes: []string{"BinaryExpr"},
			wantSQL:       []string{"1 + 2"},
		},
		{
			name:          "type",
			mode:          "type",
			source:        "ARRAY<STRING>",
			wantNodeTypes: []string{"ArrayType"},
			wantSQL:       []string{"ARRAY<STRING>"},
		},
		{
			name:          "schema type",
			mode:          "schemaType",
			source:        "ARRAY<STRING(MAX)>",
			wantNodeTypes: []string{"ArraySchemaType"},
			wantSQL:       []string{"ARRAY<STRING(MAX)>"},
		},
		{
			name:          "ddl",
			mode:          "ddl",
			source:        "DROP TABLE T",
			wantNodeTypes: []string{"DropTable"},
			wantSQL:       []string{"DROP TABLE T"},
		},
		{
			name:          "ddls",
			mode:          "ddls",
			source:        "DROP TABLE T; DROP INDEX I",
			wantNodeTypes: []string{"DropTable", "DropIndex"},
			wantSQL:       []string{"DROP TABLE T", "DROP INDEX I"},
		},
		{
			name:          "dml",
			mode:          "dml",
			source:        "INSERT INTO T (K) VALUES (1)",
			wantNodeTypes: []string{"Insert"},
			wantSQL:       []string{"INSERT INTO T (K) VALUES (1)"},
		},
		{
			name:          "dmls",
			mode:          "dmls",
			source:        "INSERT INTO T (K) VALUES (1); DELETE FROM T WHERE K = 1",
			wantNodeTypes: []string{"Insert", "Delete"},
			wantSQL:       []string{"INSERT INTO T (K) VALUES (1)", "DELETE FROM T WHERE K = 1"},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			response := handleRequest(t, Request{
				ProtocolVersion: ProtocolVersion,
				ID:              test.name,
				Mode:            test.mode,
				Source:          test.source,
			})

			if !response.OK {
				t.Fatalf("OK = false, fatal = %#v, diagnostics = %#v", response.Fatal, response.Diagnostics)
			}
			if response.Fatal != nil {
				t.Fatalf("Fatal = %#v, want nil", response.Fatal)
			}
			if response.ProtocolVersion != ProtocolVersion {
				t.Errorf("ProtocolVersion = %d, want %d", response.ProtocolVersion, ProtocolVersion)
			}
			if response.ID != test.name {
				t.Errorf("ID = %q, want %q", response.ID, test.name)
			}
			if response.Engine != testEngine {
				t.Errorf("Engine = %#v, want %#v", response.Engine, testEngine)
			}
			if response.Results == nil {
				t.Fatal("Results is nil, want initialized array")
			}
			if response.Diagnostics == nil {
				t.Fatal("Diagnostics is nil, want initialized array")
			}
			if len(response.Diagnostics) != 0 {
				t.Errorf("Diagnostics = %#v, want none", response.Diagnostics)
			}
			if len(response.Results) != len(test.wantNodeTypes) {
				t.Fatalf("len(Results) = %d, want %d", len(response.Results), len(test.wantNodeTypes))
			}

			for index, result := range response.Results {
				if result.NodeType != test.wantNodeTypes[index] {
					t.Errorf("Results[%d].NodeType = %q, want %q", index, result.NodeType, test.wantNodeTypes[index])
				}
				if result.SQL != test.wantSQL[index] {
					t.Errorf("Results[%d].SQL = %q, want %q", index, result.SQL, test.wantSQL[index])
				}
				if result.AST.Type != result.NodeType {
					t.Errorf("Results[%d].AST.Type = %q, want %q", index, result.AST.Type, result.NodeType)
				}
				if result.AST.Fields == nil {
					t.Errorf("Results[%d].AST.Fields is nil", index)
				}
				if result.Range.StartByte < 0 || result.Range.EndByte > len(test.source) {
					t.Errorf("Results[%d].Range = %#v, source length = %d", index, result.Range, len(test.source))
				}
			}
		})
	}
}

func TestHandlerPreservesPartialResultWithDiagnostics(t *testing.T) {
	t.Parallel()

	response := handleRequest(t, Request{
		ProtocolVersion: ProtocolVersion,
		ID:              "partial",
		Mode:            "statement",
		Source:          "SELECT 1 +",
	})

	if response.OK {
		t.Fatal("OK = true, want false")
	}
	if response.Fatal != nil {
		t.Fatalf("Fatal = %#v, want nil", response.Fatal)
	}
	if len(response.Results) != 1 {
		t.Fatalf("len(Results) = %d, want 1 partial root", len(response.Results))
	}
	if response.Results[0].NodeType != "QueryStatement" {
		t.Errorf("Results[0].NodeType = %q, want QueryStatement", response.Results[0].NodeType)
	}
	if response.Results[0].SQL == "" {
		t.Error("Results[0].SQL is empty, want recovered SQL")
	}
	if len(response.Diagnostics) == 0 {
		t.Fatal("Diagnostics is empty, want syntax diagnostic")
	}
	for index, diagnostic := range response.Diagnostics {
		if diagnostic.Message == "" {
			t.Errorf("Diagnostics[%d].Message is empty", index)
		}
		if diagnostic.Range.StartByte < 0 || diagnostic.Range.EndByte > len("SELECT 1 +") {
			t.Errorf("Diagnostics[%d].Range = %#v", index, diagnostic.Range)
		}
	}
}

func TestHandlerInvalidRequests(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		requestJSON string
		wantID      string
		messagePart string
	}{
		{
			name:        "malformed JSON",
			requestJSON: `{`,
			messagePart: "invalid request JSON",
		},
		{
			name:        "trailing JSON",
			requestJSON: `{"protocolVersion":1,"id":"trailing","mode":"query","source":"SELECT 1"} {}`,
			wantID:      "trailing",
			messagePart: "multiple JSON values",
		},
		{
			name:        "unknown field",
			requestJSON: `{"protocolVersion":1,"id":"extra","mode":"query","source":"SELECT 1","extra":true}`,
			wantID:      "extra",
			messagePart: "unknown field",
		},
		{
			name: "wrong protocol",
			requestJSON: mustRequestJSON(t, Request{
				ProtocolVersion: 2,
				ID:              "protocol",
				Mode:            "query",
				Source:          "SELECT 1",
			}),
			wantID:      "protocol",
			messagePart: "unsupported protocol version",
		},
		{
			name: "empty id",
			requestJSON: mustRequestJSON(t, Request{
				ProtocolVersion: ProtocolVersion,
				Mode:            "query",
				Source:          "SELECT 1",
			}),
			messagePart: "id must not be empty",
		},
		{
			name: "unknown mode",
			requestJSON: mustRequestJSON(t, Request{
				ProtocolVersion: ProtocolVersion,
				ID:              "mode",
				Mode:            "gql",
				Source:          "GRAPH G MATCH (n) RETURN n",
			}),
			wantID:      "mode",
			messagePart: "unknown parser mode",
		},
		{
			name: "source too large",
			requestJSON: mustRequestJSON(t, Request{
				ProtocolVersion: ProtocolVersion,
				ID:              "size",
				Mode:            "query",
				Source:          strings.Repeat("x", MaxSourceBytes+1),
			}),
			wantID:      "size",
			messagePart: "1048576-byte limit",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			responseJSON := NewHandler(testEngine).Handle(test.requestJSON)
			response := decodeResponse(t, responseJSON)
			if response.OK {
				t.Fatal("OK = true, want false")
			}
			if response.ID != test.wantID {
				t.Errorf("ID = %q, want %q", response.ID, test.wantID)
			}
			if response.Fatal == nil {
				t.Fatal("Fatal is nil")
			}
			if response.Fatal.Kind != "invalid_request" {
				t.Errorf("Fatal.Kind = %q, want invalid_request", response.Fatal.Kind)
			}
			if !strings.Contains(response.Fatal.Message, test.messagePart) {
				t.Errorf("Fatal.Message = %q, want it to contain %q", response.Fatal.Message, test.messagePart)
			}
			if response.Results == nil || response.Diagnostics == nil {
				t.Fatalf("Results or Diagnostics is nil: %#v", response)
			}
			if len(response.Results) != 0 || len(response.Diagnostics) != 0 {
				t.Errorf("Results = %#v, Diagnostics = %#v; want empty", response.Results, response.Diagnostics)
			}
		})
	}
}

func TestHandlerContainsLeadingLexerPanic(t *testing.T) {
	t.Parallel()

	handler := NewHandler(testEngine)
	response := handleWithHandler(t, handler, Request{
		ProtocolVersion: ProtocolVersion,
		ID:              "panic",
		Mode:            "statement",
		Source:          "\b",
	})

	if response.OK {
		t.Fatal("OK = true, want false")
	}
	if response.Fatal != nil {
		if response.Fatal.Kind != "parser_panic" {
			t.Fatalf("Fatal.Kind = %q, want parser_panic", response.Fatal.Kind)
		}
	} else if len(response.Diagnostics) == 0 {
		t.Fatal("want parser_panic or a future upstream syntax diagnostic")
	}

	// A contained panic must not poison the long-lived handler used by the
	// Worker for subsequent requests.
	valid := handleWithHandler(t, handler, Request{
		ProtocolVersion: ProtocolVersion,
		ID:              "after-panic",
		Mode:            "query",
		Source:          "SELECT 1",
	})
	if !valid.OK {
		t.Fatalf("valid request after panic failed: fatal = %#v, diagnostics = %#v", valid.Fatal, valid.Diagnostics)
	}
}

func TestHandlerJSONArraysAreNeverNull(t *testing.T) {
	t.Parallel()

	handler := NewHandler(testEngine)
	tests := []struct {
		name    string
		request Request
	}{
		{
			name: "success",
			request: Request{
				ProtocolVersion: ProtocolVersion,
				ID:              "success",
				Mode:            "query",
				Source:          "SELECT 1",
			},
		},
		{
			name: "syntax diagnostic",
			request: Request{
				ProtocolVersion: ProtocolVersion,
				ID:              "diagnostic",
				Mode:            "query",
				Source:          "SELECT 1 +",
			},
		},
		{
			name: "fatal",
			request: Request{
				ProtocolVersion: ProtocolVersion,
				ID:              "fatal",
				Mode:            "unknown",
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			responseJSON := handler.Handle(mustRequestJSON(t, test.request))
			var fields map[string]json.RawMessage
			if err := json.Unmarshal([]byte(responseJSON), &fields); err != nil {
				t.Fatalf("json.Unmarshal() error = %v; JSON = %s", err, responseJSON)
			}
			for _, field := range []string{"results", "diagnostics"} {
				if string(fields[field]) == "null" {
					t.Errorf("%s = null, want array", field)
				}
				var values []json.RawMessage
				if err := json.Unmarshal(fields[field], &values); err != nil {
					t.Errorf("%s is not an array: %v", field, err)
				}
			}
		})
	}
}

func TestHandlerJSONContract(t *testing.T) {
	t.Parallel()

	responseJSON := NewHandler(testEngine).Handle(mustRequestJSON(t, Request{
		ProtocolVersion: ProtocolVersion,
		ID:              "contract",
		Mode:            "query",
		Source:          "SELECT 1",
	}))

	var response map[string]json.RawMessage
	if err := json.Unmarshal([]byte(responseJSON), &response); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}
	assertJSONKeys(
		t,
		response,
		"protocolVersion",
		"id",
		"ok",
		"engine",
		"results",
		"diagnostics",
		"fatal",
	)
	if string(response["fatal"]) != "null" {
		t.Errorf("fatal = %s, want null", response["fatal"])
	}

	var engine map[string]json.RawMessage
	if err := json.Unmarshal(response["engine"], &engine); err != nil {
		t.Fatalf("engine is not an object: %v", err)
	}
	assertJSONKeys(
		t,
		engine,
		"channel",
		"version",
		"commit",
		"goVersion",
	)

	var results []map[string]json.RawMessage
	if err := json.Unmarshal(response["results"], &results); err != nil {
		t.Fatalf("results is not an array of objects: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("len(results) = %d, want 1", len(results))
	}
	assertJSONKeys(
		t,
		results[0],
		"nodeType",
		"range",
		"sql",
		"ast",
	)

	var sourceRange map[string]json.RawMessage
	if err := json.Unmarshal(results[0]["range"], &sourceRange); err != nil {
		t.Fatalf("range is not an object: %v", err)
	}
	assertJSONKeys(
		t,
		sourceRange,
		"startByte",
		"endByte",
		"from",
		"to",
	)

	var projectedAST map[string]json.RawMessage
	if err := json.Unmarshal(results[0]["ast"], &projectedAST); err != nil {
		t.Fatalf("ast is not an object: %v", err)
	}
	assertJSONKeys(
		t,
		projectedAST,
		"type",
		"range",
		"fields",
	)
}

func TestHandlerEncodeFailure(t *testing.T) {
	t.Parallel()

	handler := NewHandler(testEngine)
	response := handler.newResponse("encode")
	response.Results = append(response.Results, Result{
		AST: ProjectedAST{
			Type: "Synthetic",
			Fields: map[string]any{
				"NotJSON": math.NaN(),
			},
		},
	})

	encoded := decodeResponse(t, handler.encodeResponse(response))
	if encoded.Fatal == nil || encoded.Fatal.Kind != "encode_failure" {
		t.Fatalf("Fatal = %#v, want encode_failure", encoded.Fatal)
	}
	if encoded.Results == nil || encoded.Diagnostics == nil {
		t.Fatalf("fallback arrays must be initialized: %#v", encoded)
	}
}

func TestHandlerReadyJSON(t *testing.T) {
	t.Parallel()

	readyJSON, err := NewHandler(testEngine).ReadyJSON()
	if err != nil {
		t.Fatalf("ReadyJSON() error = %v", err)
	}
	want := `{"type":"ready","protocolVersion":1,` +
		`"engine":{"channel":"release","version":"v0.8.0",` +
		`"commit":"0123456789abcdef","goVersion":"go1.26.5"}}`
	if readyJSON != want {
		t.Errorf("ReadyJSON() = %s, want %s", readyJSON, want)
	}
}

func handleRequest(t *testing.T, request Request) Response {
	t.Helper()
	return handleWithHandler(t, NewHandler(testEngine), request)
}

func handleWithHandler(t *testing.T, handler *Handler, request Request) Response {
	t.Helper()
	return decodeResponse(t, handler.Handle(mustRequestJSON(t, request)))
}

func mustRequestJSON(t *testing.T, request Request) string {
	t.Helper()
	encoded, err := json.Marshal(request)
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	return string(encoded)
}

func decodeResponse(t *testing.T, responseJSON string) Response {
	t.Helper()
	var response Response
	if err := json.Unmarshal([]byte(responseJSON), &response); err != nil {
		t.Fatalf("json.Unmarshal() error = %v; JSON = %s", err, responseJSON)
	}
	return response
}

func assertJSONKeys(t *testing.T, object map[string]json.RawMessage, want ...string) {
	t.Helper()
	if len(object) != len(want) {
		t.Errorf("JSON object has %d fields, want %d: %#v", len(object), len(want), object)
	}
	for _, key := range want {
		if _, exists := object[key]; !exists {
			t.Errorf("JSON object is missing field %q: %#v", key, object)
		}
	}
}
