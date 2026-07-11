package bridge

import (
	"testing"

	"github.com/cloudspannerecosystem/memefish"
	"github.com/cloudspannerecosystem/memefish/ast"
	"github.com/cloudspannerecosystem/memefish/token"
)

func TestProjectNodePreservesNestedConcreteTypes(t *testing.T) {
	t.Parallel()

	node, err := memefish.ParseQuery("", "SELECT 1 + 2 ORDER BY 1")
	if err != nil {
		t.Fatalf("ParseQuery() error = %v", err)
	}
	root := projectNode(node)

	query := projectedField(t, root, "Query")
	if query.Type != "Query" {
		t.Fatalf("Query.Type = %q, want Query", query.Type)
	}
	selectNode := projectedField(t, query, "Query")
	if selectNode.Type != "Select" {
		t.Fatalf("Query.Query.Type = %q, want Select", selectNode.Type)
	}

	results, ok := selectNode.Fields["Results"].([]any)
	if !ok {
		t.Fatalf("Select.Results = %#v, want []any", selectNode.Fields["Results"])
	}
	if len(results) != 1 {
		t.Fatalf("len(Select.Results) = %d, want 1", len(results))
	}
	selectItem, ok := results[0].(ProjectedAST)
	if !ok {
		t.Fatalf("Select.Results[0] = %#v, want ProjectedAST", results[0])
	}
	if selectItem.Type != "ExprSelectItem" {
		t.Fatalf("Select.Results[0].Type = %q, want ExprSelectItem", selectItem.Type)
	}
	expression := projectedField(t, selectItem, "Expr")
	if expression.Type != "BinaryExpr" {
		t.Fatalf("ExprSelectItem.Expr.Type = %q, want BinaryExpr", expression.Type)
	}
	if left := projectedField(t, expression, "Left"); left.Type != "IntLiteral" {
		t.Errorf("BinaryExpr.Left.Type = %q, want IntLiteral", left.Type)
	}
	if right := projectedField(t, expression, "Right"); right.Type != "IntLiteral" {
		t.Errorf("BinaryExpr.Right.Type = %q, want IntLiteral", right.Type)
	}

	pipeOperators, ok := query.Fields["PipeOperators"].([]any)
	if !ok || pipeOperators == nil || len(pipeOperators) != 0 {
		t.Errorf("Query.PipeOperators = %#v, want initialized empty list", query.Fields["PipeOperators"])
	}
}

func TestProjectNodeOmitsInvalidPositions(t *testing.T) {
	t.Parallel()

	node := &ast.Select{
		Select:  token.InvalidPos,
		Results: nil,
	}
	projected := projectNode(node)
	if _, exists := projected.Fields["Select"]; exists {
		t.Errorf("Select position is present: %#v", projected.Fields["Select"])
	}
	results, ok := projected.Fields["Results"].([]any)
	if !ok || results == nil || len(results) != 0 {
		t.Errorf("Results = %#v, want initialized empty list", projected.Fields["Results"])
	}
	if _, exists := projected.Fields["AllOrDistinct"]; !exists {
		t.Error("exported scalar AllOrDistinct was omitted")
	}
}

func TestProjectNodeContainsCycles(t *testing.T) {
	t.Parallel()

	node := &ast.ParenExpr{
		Lparen: 0,
		Rparen: 1,
	}
	node.Expr = node
	projected := projectNode(node)

	nested := projectedField(t, projected, "Expr")
	if nested.Type != "ParenExpr" {
		t.Fatalf("Expr.Type = %q, want ParenExpr", nested.Type)
	}
	if nested.Fields == nil || len(nested.Fields) != 0 {
		t.Errorf("cyclic Expr.Fields = %#v, want initialized empty truncation", nested.Fields)
	}
}

func TestNewSourceRangeUTF16(t *testing.T) {
	t.Parallel()

	const source = "A😀éZ"
	tests := []struct {
		name      string
		startByte int
		endByte   int
		want      SourceRange
	}{
		{
			name:      "ASCII",
			startByte: 0,
			endByte:   1,
			want: SourceRange{
				StartByte: 0,
				EndByte:   1,
				From:      0,
				To:        1,
			},
		},
		{
			name:      "astral rune",
			startByte: 1,
			endByte:   5,
			want: SourceRange{
				StartByte: 1,
				EndByte:   5,
				From:      1,
				To:        3,
			},
		},
		{
			name:      "BMP non-ASCII rune",
			startByte: 5,
			endByte:   7,
			want: SourceRange{
				StartByte: 5,
				EndByte:   7,
				From:      3,
				To:        4,
			},
		},
		{
			name:      "out of bounds",
			startByte: -10,
			endByte:   100,
			want: SourceRange{
				StartByte: 0,
				EndByte:   len(source),
				From:      0,
				To:        5,
			},
		},
		{
			name:      "end before start",
			startByte: len(source),
			endByte:   -1,
			want: SourceRange{
				StartByte: len(source),
				EndByte:   len(source),
				From:      5,
				To:        5,
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if got := newSourceRange(source, test.startByte, test.endByte); got != test.want {
				t.Errorf("newSourceRange() = %#v, want %#v", got, test.want)
			}
		})
	}
}

func projectedField(t *testing.T, parent ProjectedAST, name string) ProjectedAST {
	t.Helper()
	value, exists := parent.Fields[name]
	if !exists {
		t.Fatalf("%s.Fields[%q] is missing", parent.Type, name)
	}
	projected, ok := value.(ProjectedAST)
	if !ok {
		t.Fatalf("%s.Fields[%q] = %#v, want ProjectedAST", parent.Type, name, value)
	}
	return projected
}
