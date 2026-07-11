//go:build memefish_pre_v0_8

package bridge

import "testing"

func TestHandlerRejectsUnsupportedSchemaType(t *testing.T) {
	t.Parallel()

	handler := NewHandler(Engine{
		Channel:   "release",
		Version:   "v0.7.0",
		Commit:    "0123456789abcdef",
		GoVersion: "go1.26.5",
	})
	response := handleWithHandler(t, handler, Request{
		ProtocolVersion: ProtocolVersion,
		ID:              "legacy-schema-type",
		Mode:            "schemaType",
		Source:          "ARRAY<STRING(MAX)>",
	})

	if response.OK {
		t.Fatal("OK = true, want false")
	}
	if response.Fatal == nil {
		t.Fatal("Fatal is nil")
	}
	if response.Fatal.Kind != "invalid_request" {
		t.Errorf("Fatal.Kind = %q, want invalid_request", response.Fatal.Kind)
	}
	if len(response.Results) != 0 || len(response.Diagnostics) != 0 {
		t.Errorf(
			"Results = %#v, Diagnostics = %#v; want empty",
			response.Results,
			response.Diagnostics,
		)
	}
}
