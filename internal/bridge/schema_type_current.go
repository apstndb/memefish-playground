//go:build !memefish_pre_v0_8

package bridge

import (
	"github.com/cloudspannerecosystem/memefish"
	"github.com/cloudspannerecosystem/memefish/ast"
)

func parseSchemaType(source string) (ast.Node, error) {
	return memefish.ParseSchemaType("", source)
}
