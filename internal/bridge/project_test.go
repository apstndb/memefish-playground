package bridge

import (
	"testing"

	"github.com/cloudspannerecosystem/memefish"
	"github.com/cloudspannerecosystem/memefish/ast"
	"github.com/cloudspannerecosystem/memefish/token"
)

func TestProjectNodePreservesNestedConcreteTypes(t *testing.T) {
	t.Parallel()

	const source = "SELECT 1 + 2 ORDER BY 1"
	node, err := memefish.ParseQuery("", source)
	if err != nil {
		t.Fatalf("ParseQuery() error = %v", err)
	}
	root := projectNode(source, node)
	assertAllProjectedRanges(t, root)

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
	projected := projectNode("", node)
	if projected.Range != nil {
		t.Errorf("Range = %#v, want omitted invalid range", projected.Range)
	}
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
	projected := projectNode("()", node)

	nested := projectedField(t, projected, "Expr")
	if nested.Type != "ParenExpr" {
		t.Fatalf("Expr.Type = %q, want ParenExpr", nested.Type)
	}
	if nested.Fields == nil || len(nested.Fields) != 0 {
		t.Errorf("cyclic Expr.Fields = %#v, want initialized empty truncation", nested.Fields)
	}
	assertProjectedRange(t, nested, SourceRange{
		StartByte: 0,
		EndByte:   2,
		From:      0,
		To:        2,
	})
}

func TestProjectNodeRangesUseUTF8BytesAndUTF16Offsets(t *testing.T) {
	t.Parallel()

	const source = "SELECT '😀' + 'é'"
	node, err := memefish.ParseQuery("", source)
	if err != nil {
		t.Fatalf("ParseQuery() error = %v", err)
	}
	root := projectNode(source, node)

	selectNode := projectedField(t, root, "Query")
	results := projectedListField(t, selectNode, "Results")
	selectItem := projectedListItem(t, results, 0)
	expression := projectedField(t, selectItem, "Expr")
	if expression.Type != "BinaryExpr" {
		t.Fatalf("ExprSelectItem.Expr.Type = %q, want BinaryExpr", expression.Type)
	}
	assertProjectedRange(t, expression, SourceRange{
		StartByte: 7,
		EndByte:   len(source),
		From:      7,
		To:        17,
	})
	assertProjectedRange(t, projectedField(t, expression, "Left"), SourceRange{
		StartByte: 7,
		EndByte:   13,
		From:      7,
		To:        11,
	})
	assertProjectedRange(t, projectedField(t, expression, "Right"), SourceRange{
		StartByte: 16,
		EndByte:   len(source),
		From:      14,
		To:        17,
	})
}

func TestMakeResultsUsesSharedSourceIndexForMultipleStatements(t *testing.T) {
	t.Parallel()

	const source = "SELECT '😀'; SELECT 'é'"
	nodes, err := parse("statements", source)
	if err != nil {
		t.Fatalf("parse() error = %v", err)
	}
	sourceIndex := newSourceIndex(source)
	results := makeResults(sourceIndex, nodes)
	wants := []struct {
		root    SourceRange
		literal SourceRange
	}{
		{
			root: SourceRange{
				StartByte: 0,
				EndByte:   13,
				From:      0,
				To:        11,
			},
			literal: SourceRange{
				StartByte: 7,
				EndByte:   13,
				From:      7,
				To:        11,
			},
		},
		{
			root: SourceRange{
				StartByte: 15,
				EndByte:   len(source),
				From:      13,
				To:        23,
			},
			literal: SourceRange{
				StartByte: 22,
				EndByte:   len(source),
				From:      20,
				To:        23,
			},
		},
	}

	if len(results) != len(wants) {
		t.Fatalf("len(makeResults()) = %d, want %d", len(results), len(wants))
	}
	for index, want := range wants {
		if results[index].Range != want.root {
			t.Errorf("Results[%d].Range = %#v, want %#v", index, results[index].Range, want.root)
		}
		assertProjectedRange(t, results[index].AST, want.root)
		literals := findProjectedByType(results[index].AST, "StringLiteral")
		if len(literals) != 1 {
			t.Fatalf("Results[%d] StringLiteral count = %d, want 1", index, len(literals))
		}
		assertProjectedRange(t, literals[0], want.literal)
	}
}

func TestProjectNodePreservesNilInterfaceSliceElements(t *testing.T) {
	t.Parallel()

	const source = "SELECT 1"
	node, err := memefish.ParseQuery("", source)
	if err != nil {
		t.Fatalf("ParseQuery() error = %v", err)
	}
	selectNode, ok := node.Query.(*ast.Select)
	if !ok {
		t.Fatalf("QueryStatement.Query = %T, want *ast.Select", node.Query)
	}
	var nilSelectItem *ast.ExprSelectItem
	selectNode.Results = append([]ast.SelectItem{nilSelectItem}, selectNode.Results...)

	projected := projectNode(source, node)
	projectedSelect := projectedField(t, projected, "Query")
	results := projectedListField(t, projectedSelect, "Results")
	if len(results) != 2 {
		t.Fatalf("len(Select.Results) = %d, want 2", len(results))
	}
	if results[0] != nil {
		t.Errorf("Select.Results[0] = %#v, want nil", results[0])
	}
	assertProjectedRange(t, projectedListItem(t, results, 1), SourceRange{
		StartByte: 7,
		EndByte:   8,
		From:      7,
		To:        8,
	})
}

func TestProjectNodeRangesRecoveryNodes(t *testing.T) {
	t.Parallel()

	const source = "SELECT '😀' +"
	node, err := memefish.ParseQuery("", source)
	if err == nil {
		t.Fatal("ParseQuery() error = nil, want recovery diagnostic")
	}
	root := projectNode(source, node)
	badExpressions := findProjectedByType(root, "BadExpr")
	if len(badExpressions) != 1 {
		t.Fatalf("BadExpr projection count = %d, want 1", len(badExpressions))
	}
	want := SourceRange{
		StartByte: 7,
		EndByte:   len(source),
		From:      7,
		To:        13,
	}
	assertProjectedRange(t, badExpressions[0], want)
	assertProjectedRange(t, projectedField(t, badExpressions[0], "BadNode"), want)
}

func TestProjectNodeOmitsInvalidAndOutOfBoundsRanges(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		node *ast.BadNode
	}{
		{
			name: "invalid start",
			node: &ast.BadNode{NodePos: token.InvalidPos, NodeEnd: 1},
		},
		{
			name: "end before start",
			node: &ast.BadNode{NodePos: 1, NodeEnd: 0},
		},
		{
			name: "end after source",
			node: &ast.BadNode{NodePos: 0, NodeEnd: 3},
		},
		{
			name: "start within UTF-8 rune",
			node: &ast.BadNode{NodePos: 1, NodeEnd: 2},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			projected := projectNode("é", test.node)
			if projected.Range != nil {
				t.Errorf("Range = %#v, want omitted invalid range", projected.Range)
			}
		})
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

func TestSourceIndexUTF16Offsets(t *testing.T) {
	t.Parallel()

	const source = "A😀éZ"
	sourceIndex := newSourceIndex(source)
	tests := []struct {
		name       string
		byteOffset int
		want       int
	}{
		{name: "before source", byteOffset: -1, want: 0},
		{name: "start", byteOffset: 0, want: 0},
		{name: "after ASCII", byteOffset: 1, want: 1},
		{name: "astral byte 1", byteOffset: 2, want: 1},
		{name: "astral byte 2", byteOffset: 3, want: 1},
		{name: "astral byte 3", byteOffset: 4, want: 1},
		{name: "after astral rune", byteOffset: 5, want: 3},
		{name: "BMP byte 1", byteOffset: 6, want: 3},
		{name: "after BMP rune", byteOffset: 7, want: 4},
		{name: "end", byteOffset: 8, want: 5},
		{name: "after source", byteOffset: 99, want: 5},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if got := sourceIndex.utf16Offset(test.byteOffset); got != test.want {
				t.Errorf("utf16Offset(%d) = %d, want %d", test.byteOffset, got, test.want)
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

func projectedListField(t *testing.T, parent ProjectedAST, name string) []any {
	t.Helper()
	value, exists := parent.Fields[name]
	if !exists {
		t.Fatalf("%s.Fields[%q] is missing", parent.Type, name)
	}
	list, ok := value.([]any)
	if !ok {
		t.Fatalf("%s.Fields[%q] = %#v, want []any", parent.Type, name, value)
	}
	return list
}

func projectedListItem(t *testing.T, list []any, index int) ProjectedAST {
	t.Helper()
	if index < 0 || index >= len(list) {
		t.Fatalf("list index %d is out of bounds for length %d", index, len(list))
	}
	projected, ok := list[index].(ProjectedAST)
	if !ok {
		t.Fatalf("list[%d] = %#v, want ProjectedAST", index, list[index])
	}
	return projected
}

func assertProjectedRange(t *testing.T, projected ProjectedAST, want SourceRange) {
	t.Helper()
	if projected.Range == nil {
		t.Fatalf("%s.Range is nil, want %#v", projected.Type, want)
	}
	if *projected.Range != want {
		t.Errorf("%s.Range = %#v, want %#v", projected.Type, *projected.Range, want)
	}
}

func findProjectedByType(root ProjectedAST, nodeType string) []ProjectedAST {
	found := []ProjectedAST{}
	var visit func(any)
	visit = func(value any) {
		switch value := value.(type) {
		case ProjectedAST:
			if value.Type == nodeType {
				found = append(found, value)
			}
			for _, field := range value.Fields {
				visit(field)
			}
		case []any:
			for _, item := range value {
				visit(item)
			}
		case map[string]any:
			for _, item := range value {
				visit(item)
			}
		}
	}
	visit(root)
	return found
}

func assertAllProjectedRanges(t *testing.T, root ProjectedAST) {
	t.Helper()
	var visit func(any)
	visit = func(value any) {
		switch value := value.(type) {
		case ProjectedAST:
			if value.Range == nil {
				t.Errorf("%s.Range is nil", value.Type)
			}
			for _, field := range value.Fields {
				visit(field)
			}
		case []any:
			for _, item := range value {
				visit(item)
			}
		case map[string]any:
			for _, item := range value {
				visit(item)
			}
		}
	}
	visit(root)
}
