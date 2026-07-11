//go:build js && wasm

package main

import (
	"fmt"
	"runtime"
	"syscall/js"

	"github.com/apstndb/memefish-playground/internal/bridge"
)

var (
	channel = "unknown"
	version = "unknown"
	commit  = "unknown"

	parseFunction js.Func
)

func main() {
	handler := bridge.NewHandler(bridge.Engine{
		Channel:   channel,
		Version:   version,
		Commit:    commit,
		GoVersion: runtime.Version(),
	})

	parseFunction = js.FuncOf(func(_ js.Value, args []js.Value) any {
		if len(args) != 1 || args[0].Type() != js.TypeString {
			return handler.Handle("")
		}
		return handler.Handle(args[0].String())
	})

	global := js.Global()
	global.Set("__memefishParse", parseFunction)

	readyJSON, err := handler.ReadyJSON()
	if err != nil {
		panic(fmt.Errorf("preparing Worker ready notification: %w", err))
	}
	global.Call("postMessage", readyJSON)

	select {}
}
