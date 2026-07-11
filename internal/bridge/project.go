package bridge

import (
	"reflect"
	"unicode/utf8"

	"github.com/cloudspannerecosystem/memefish/ast"
	"github.com/cloudspannerecosystem/memefish/token"
)

const maxProjectionDepth = 64

var tokenPosType = reflect.TypeFor[token.Pos]()
var astNodeType = reflect.TypeFor[ast.Node]()

type projectionVisit struct {
	typeOf  reflect.Type
	pointer uintptr
}

// sourceIndex is an immutable UTF-8 byte-position to UTF-16 code-unit index
// shared by every projection and diagnostic for one source string.
type sourceIndex struct {
	source         string
	utf16ByBytePos []int
}

type projector struct {
	sourceIndex *sourceIndex
	path        map[projectionVisit]struct{}
}

func projectNode(source string, node ast.Node) ProjectedAST {
	return projectNodeWithSourceIndex(newSourceIndex(source), node)
}

func projectNodeWithSourceIndex(sourceIndex *sourceIndex, node ast.Node) ProjectedAST {
	state := projector{
		sourceIndex: sourceIndex,
		path:        map[projectionVisit]struct{}{},
	}
	projected, ok := state.project(reflect.ValueOf(node), 0)
	if ok {
		if root, isProjectedAST := projected.(ProjectedAST); isProjectedAST {
			return root
		}
	}

	return ProjectedAST{
		Type:   concreteTypeName(reflect.TypeOf(node)),
		Range:  sourceRangeForNode(sourceIndex, node),
		Fields: map[string]any{},
	}
}

func (p *projector) project(value reflect.Value, depth int) (any, bool) {
	if !value.IsValid() {
		return nil, true
	}
	if depth >= maxProjectionDepth {
		return p.truncatedProjection(value), true
	}

	if value.Type() == tokenPosType {
		if token.Pos(value.Int()).Invalid() {
			return nil, false
		}
		return value.Int(), true
	}

	switch value.Kind() {
	case reflect.Interface:
		if value.IsNil() {
			return nil, true
		}
		return p.project(value.Elem(), depth+1)
	case reflect.Pointer:
		if value.IsNil() {
			return nil, true
		}

		visit := projectionVisit{
			typeOf:  value.Type(),
			pointer: value.Pointer(),
		}
		if _, seen := p.path[visit]; seen {
			return p.truncatedProjection(value), true
		}
		p.path[visit] = struct{}{}
		defer delete(p.path, visit)
		return p.project(value.Elem(), depth+1)
	case reflect.Struct:
		fields := map[string]any{}
		valueType := value.Type()
		for index := range value.NumField() {
			fieldType := valueType.Field(index)
			if fieldType.PkgPath != "" {
				continue
			}

			field, include := p.project(value.Field(index), depth+1)
			if include {
				fields[fieldType.Name] = field
			}
		}
		return ProjectedAST{
			Type:   concreteTypeName(valueType),
			Range:  p.sourceRange(value),
			Fields: fields,
		}, true
	case reflect.Slice, reflect.Array:
		items := make([]any, 0, value.Len())
		for index := range value.Len() {
			item, include := p.project(value.Index(index), depth+1)
			if include {
				items = append(items, item)
			}
		}
		return items, true
	case reflect.Map:
		fields := map[string]any{}
		if value.Type().Key().Kind() != reflect.String {
			return fields, false
		}
		iterator := value.MapRange()
		for iterator.Next() {
			item, include := p.project(iterator.Value(), depth+1)
			if include {
				fields[iterator.Key().String()] = item
			}
		}
		return fields, true
	case reflect.Bool:
		return value.Bool(), true
	case reflect.String:
		return value.String(), true
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return value.Int(), true
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Uintptr:
		return value.Uint(), true
	case reflect.Float32, reflect.Float64:
		return value.Float(), true
	default:
		return nil, false
	}
}

func (p *projector) truncatedProjection(value reflect.Value) any {
	sourceRange := p.sourceRange(value)
	for value.IsValid() && (value.Kind() == reflect.Interface || value.Kind() == reflect.Pointer) {
		if value.IsNil() {
			return nil
		}
		value = value.Elem()
	}
	if value.IsValid() && value.Kind() == reflect.Struct {
		return ProjectedAST{
			Type:   concreteTypeName(value.Type()),
			Range:  sourceRange,
			Fields: map[string]any{},
		}
	}
	if value.IsValid() && (value.Kind() == reflect.Slice || value.Kind() == reflect.Array) {
		return []any{}
	}
	return nil
}

func (p *projector) sourceRange(value reflect.Value) *SourceRange {
	node, ok := nodeFromValue(value)
	if !ok {
		return nil
	}
	return sourceRangeForNode(p.sourceIndex, node)
}

func nodeFromValue(value reflect.Value) (ast.Node, bool) {
	for value.IsValid() && value.Kind() == reflect.Interface {
		if value.IsNil() {
			return nil, false
		}
		value = value.Elem()
	}
	if !value.IsValid() {
		return nil, false
	}
	if value.Kind() == reflect.Pointer && value.IsNil() {
		return nil, false
	}

	if value.CanInterface() && value.Type().Implements(astNodeType) {
		node, ok := value.Interface().(ast.Node)
		return node, ok && validNode(node)
	}
	if value.Kind() != reflect.Struct || !value.CanAddr() || !value.Addr().CanInterface() {
		return nil, false
	}
	if !value.Addr().Type().Implements(astNodeType) {
		return nil, false
	}

	node, ok := value.Addr().Interface().(ast.Node)
	return node, ok && validNode(node)
}

func sourceRangeForNode(sourceIndex *sourceIndex, node ast.Node) *SourceRange {
	if !validNode(node) {
		return nil
	}

	startByte := int(node.Pos())
	endByte := int(node.End())
	if !validSourceBounds(sourceIndex.source, startByte, endByte) {
		return nil
	}

	sourceRange := sourceIndex.sourceRange(startByte, endByte)
	return &sourceRange
}

func validSourceBounds(source string, startByte, endByte int) bool {
	if startByte < 0 || endByte < startByte || endByte > len(source) {
		return false
	}
	if startByte < len(source) && !utf8.RuneStart(source[startByte]) {
		return false
	}
	return endByte == len(source) || utf8.RuneStart(source[endByte])
}

func concreteTypeName(valueType reflect.Type) string {
	if valueType == nil {
		return ""
	}
	for valueType.Kind() == reflect.Pointer {
		valueType = valueType.Elem()
	}
	if valueType.Name() != "" {
		return valueType.Name()
	}
	return valueType.String()
}

func newSourceIndex(source string) *sourceIndex {
	utf16ByBytePos := make([]int, len(source)+1)
	codeUnits := 0
	for bytePos := 0; bytePos < len(source); {
		r, size := utf8.DecodeRuneInString(source[bytePos:])
		// Preserve the previous conversion semantics for offsets inside a
		// multi-byte rune: they map to the offset before that rune.
		for partialBytePos := bytePos + 1; partialBytePos < bytePos+size; partialBytePos++ {
			utf16ByBytePos[partialBytePos] = codeUnits
		}
		if r > 0xffff {
			codeUnits += 2
		} else {
			codeUnits++
		}
		bytePos += size
		utf16ByBytePos[bytePos] = codeUnits
	}

	return &sourceIndex{
		source:         source,
		utf16ByBytePos: utf16ByBytePos,
	}
}

func newSourceRange(source string, startByte, endByte int) SourceRange {
	return newSourceIndex(source).sourceRange(startByte, endByte)
}

func (s *sourceIndex) sourceRange(startByte, endByte int) SourceRange {
	startByte = min(max(startByte, 0), len(s.source))
	endByte = min(max(endByte, startByte), len(s.source))

	return SourceRange{
		StartByte: startByte,
		EndByte:   endByte,
		From:      s.utf16Offset(startByte),
		To:        s.utf16Offset(endByte),
	}
}

func (s *sourceIndex) utf16Offset(byteOffset int) int {
	byteOffset = min(max(byteOffset, 0), len(s.source))
	return s.utf16ByBytePos[byteOffset]
}
