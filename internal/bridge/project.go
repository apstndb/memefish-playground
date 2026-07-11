package bridge

import (
	"reflect"
	"unicode/utf8"

	"github.com/cloudspannerecosystem/memefish/ast"
	"github.com/cloudspannerecosystem/memefish/token"
)

const maxProjectionDepth = 64

var tokenPosType = reflect.TypeFor[token.Pos]()

type projectionVisit struct {
	typeOf  reflect.Type
	pointer uintptr
}

type projector struct {
	path map[projectionVisit]struct{}
}

func projectNode(node ast.Node) ProjectedAST {
	state := projector{path: map[projectionVisit]struct{}{}}
	projected, ok := state.project(reflect.ValueOf(node), 0)
	if ok {
		if root, isProjectedAST := projected.(ProjectedAST); isProjectedAST {
			return root
		}
	}

	return ProjectedAST{
		Type:   concreteTypeName(reflect.TypeOf(node)),
		Fields: map[string]any{},
	}
}

func (p *projector) project(value reflect.Value, depth int) (any, bool) {
	if !value.IsValid() {
		return nil, true
	}
	if depth >= maxProjectionDepth {
		return truncatedProjection(value), true
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
			return truncatedProjection(value), true
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

func truncatedProjection(value reflect.Value) any {
	for value.IsValid() && (value.Kind() == reflect.Interface || value.Kind() == reflect.Pointer) {
		if value.IsNil() {
			return nil
		}
		value = value.Elem()
	}
	if value.IsValid() && value.Kind() == reflect.Struct {
		return ProjectedAST{
			Type:   concreteTypeName(value.Type()),
			Fields: map[string]any{},
		}
	}
	if value.IsValid() && (value.Kind() == reflect.Slice || value.Kind() == reflect.Array) {
		return []any{}
	}
	return nil
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

func newSourceRange(source string, startByte, endByte int) SourceRange {
	startByte = min(max(startByte, 0), len(source))
	endByte = min(max(endByte, startByte), len(source))

	return SourceRange{
		StartByte: startByte,
		EndByte:   endByte,
		From:      utf16Offset(source, startByte),
		To:        utf16Offset(source, endByte),
	}
}

func utf16Offset(source string, byteOffset int) int {
	byteOffset = min(max(byteOffset, 0), len(source))

	codeUnits := 0
	for index := 0; index < byteOffset; {
		r, size := utf8.DecodeRuneInString(source[index:])
		if index+size > byteOffset {
			break
		}
		if r > 0xffff {
			codeUnits += 2
		} else {
			codeUnits++
		}
		index += size
	}
	return codeUnits
}
