<p align="center">
  <img src="media/tabkyra-icon.svg" alt="Tabkyra" width="96">
</p>

# Tabkyra

A browser agent in your side panel that your other agents can also drive.

The name joins *tab* and the Greek *kybernētēs*, helmsman.

Tabkyra is a fork of [Sitegeist](https://github.com/badlogic/sitegeist) by
[Mario Zechner](https://mariozechner.at). The side-panel agent, its tools and most of this codebase
are his work. Tabkyra renames it and adds a local bridge so outside agents can use the browser.

## Development

```bash
npm install
npm run build        # unpacked extension in dist-chrome/
./check.sh           # biome, tsc, and the site check
```

Load `dist-chrome/` with **Load unpacked** on `chrome://extensions` (Developer mode on), then open the
extension's **Details** and turn on **Allow user scripts**.

## License

AGPL-3.0, the same as Sitegeist. See [LICENSE](LICENSE).
