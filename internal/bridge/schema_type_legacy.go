//go:build memefish_pre_v0_8

package bridge

import "github.com/cloudspannerecosystem/memefish/ast"

// ParseSchemaType became a public memefish API in v0.8.0. Keep older releases
// buildable, while the manifest prevents the browser from offering a mode
// their parser cannot expose safely.
func parseSchemaType(string) (ast.Node, error) {
	return nil, errUnsupportedMode
}
