# templates/

Scaffolds `music new` copies. One file per template, named for what it makes:
`song.md` is the default.

```sh
music new <slug> --channel <channel>          # uses song.md
music new <slug> --channel <channel> --template song
music new --list-templates
music new <slug> --channel <channel> --template ./my-own.md   # a path still works
```

## Adding one

Drop a `.md` file in here. It is picked up by name, with no registry to update
— `paths.templates()` lists the directory. Keep the name short and factual
(`song`, `instrumental`, `cover`), because it is what a user types.

## Placeholders

`music new` substitutes these and leaves everything else alone:

| In the file | Becomes |
|---|---|
| `<kebab-case-folder-name>` | the slug |
| `<Display title, accents and all>` | `--title`, else the slug title-cased |
| `<channel-slug>` | `--channel` |
| `<YYYY-MM-DD>` | today, first occurrence only |

Anything else in angle brackets is left for a person to fill in, deliberately:
the template is a prompt sheet as much as a file format, and a placeholder that
survives into the written file is a question still waiting for an answer.

Examples inside a placeholder — "e.g. Hijaz is a maqam whose augmented second
gives it its colour" — are there to show what KIND of answer the field wants.
They are illustrations, not defaults, and should stay specific enough to be
useful. A template full of `<TODO>` teaches nobody anything.
