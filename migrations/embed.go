// Package migrations embeds the ordered TeamTaler database migrations.
package migrations

import "embed"

// Files contains every immutable SQL migration shipped with TeamTaler.
//
//go:embed *.sql
var Files embed.FS
