#!/usr/bin/env python3
"""Builds the .vsix package of the extension without Node or vsce.

Usage: python3 package.py [output.vsix]

A .vsix is a zip with an extension.vsixmanifest, a [Content_Types].xml and
the extension files under extension/.
"""
import json
import sys
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

HERE = Path(__file__).resolve().parent
FILES = ['package.json', 'language-configuration.json', 'README.md', 'LICENSE', 'CHANGELOG.md']
DIRS = ['src', 'syntaxes']

CONTENT_TYPES = """<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json"/>
  <Default Extension=".js" ContentType="application/javascript"/>
  <Default Extension=".md" ContentType="text/markdown"/>
  <Default Extension=".txt" ContentType="text/plain"/>
  <Default Extension=".vsixmanifest" ContentType="text/xml"/>
</Types>
"""


def manifest(pkg):
    repo = pkg.get('repository', {}).get('url', '')
    props = {
        'Microsoft.VisualStudio.Code.Engine': pkg['engines']['vscode'],
        'Microsoft.VisualStudio.Code.ExtensionDependencies': ','.join(pkg.get('extensionDependencies', [])),
        'Microsoft.VisualStudio.Code.ExtensionPack': ','.join(pkg.get('extensionPack', [])),
        'Microsoft.VisualStudio.Code.ExtensionKind': ','.join(pkg.get('extensionKind', ['workspace'])),
        'Microsoft.VisualStudio.Code.LocalizedLanguages': '',
        'Microsoft.VisualStudio.Services.Links.Source': repo,
        'Microsoft.VisualStudio.Services.Links.GitHub': repo,
        'Microsoft.VisualStudio.Services.Content.Pricing': 'Free',
    }
    properties = '\n'.join(f'      <Property Id="{k}" Value="{escape(v)}" />' for k, v in props.items())
    return f"""<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="{pkg['name']}" Version="{pkg['version']}" Publisher="{pkg['publisher']}" />
    <DisplayName>{escape(pkg['displayName'])}</DisplayName>
    <Description xml:space="preserve">{escape(pkg['description'])}</Description>
    <Tags>{escape(','.join(pkg.get('keywords', [])))}</Tags>
    <Categories>{escape(','.join(pkg.get('categories', [])))}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
{properties}
    </Properties>
    <License>extension/LICENSE.txt</License>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />
  </Assets>
</PackageManifest>
"""


def main():
    pkg = json.loads((HERE / 'package.json').read_text())
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / f"{pkg['name']}-{pkg['version']}.vsix"
    files = [HERE / f for f in FILES if (HERE / f).exists()]
    for d in DIRS:
        files += sorted(p for p in (HERE / d).rglob('*') if p.is_file() and p.name != '.DS_Store')
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', CONTENT_TYPES)
        z.writestr('extension.vsixmanifest', manifest(pkg))
        for f in files:
            rel = f.relative_to(HERE).as_posix()
            z.write(f, 'extension/' + ('LICENSE.txt' if rel == 'LICENSE' else rel))
    print(f'{out}: {len(files)} files')


if __name__ == '__main__':
    main()
