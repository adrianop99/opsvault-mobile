# OpsVault Mobile

Cofre de operações criptografado (PWA) — **by @aiforge.team** · versão **v0.5**

Os dados ficam somente no aparelho, criptografados com AES-256 (chave derivada do PIN por PBKDF2). Nenhum dado é enviado a servidor. Funciona offline e pode ser instalado na tela inicial (iPhone/Safari e Android/Chrome).

## Recursos

- **Operações e alvos**: dados pessoais, telefones, veículo, endereço, prioridade, situação (preso, foragido, monitorado, solto, outro), redes sociais, mandados e foto do documento separada da galeria.
- **Vínculos entre alvos** (com relação em texto livre), mostrados nos dois alvos e num gráfico por operação.
- **Fotos** da câmera (com GPS) ou do álbum (data/GPS do EXIF), com SHA-256, capa e **carimbo** opcional (cópia com data/hora, coordenadas, operação e alvo; guarda os dois hashes).
- **Anotações em áudio** (MediaRecorder), criptografadas, ligadas ao alvo ou à operação.
- **Locais e mapa**: marcadores por tipo, busca por coordenadas, links do Google Maps ou endereço, **filtros** (operação, alvo, tipo, período), **mapa de calor** e **áreas** (raio ou polígono).
- **Mapa offline**: guarda os blocos vistos; download de área somente com servidor de mapas próprio (respeita a política do OpenStreetMap).
- **Relatório PDF da operação**: capa, resumo executivo, quadro de envolvidos, vínculos com gráfico, linha do tempo, locais e áreas, fotos com hashes e lista de áudios; marca d'água RESERVADO.
- **Exportar alvo** em PDF ou imagem (mascaramento, marca d'água, senha no PDF).
- **Planilha** (texto com `|` reimportável ou CSV) e **importação em lote** com pré-visualização e detecção de duplicados.
- **Passar operação para outro aparelho** (`.opsvault`, criptografado com senha de transferência).
- **Backup criptografado** (`.cofre`) com lembrete periódico.
- **Segurança**: trava automática, bloqueio progressivo após erros, **modo discreto**, **PIN de pânico** (cofre falso ou apagamento) e **Face ID / biometria** via WebAuthn (PRF quando disponível; o PIN é sempre a chave-mestra).

## Arquivos

`index.html`, `style.css`, `app.js`, `sw.js`, `manifest.json`, ícones e `lib/` (Leaflet 1.9.4, jsPDF). Sem build e sem dependências externas em tempo de execução, exceto os blocos do mapa e a busca de endereços (Nominatim).

> Antes de usar em serviço, confirme a política da sua instituição e a LGPD para dados de investigação.
