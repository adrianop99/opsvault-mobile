# OpsVault Mobile

Cofre de operações criptografado (PWA) — **by @aiforge.team** · versão **v0.6**

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
- **Registro rápido e Rascunhos** (v0.6): botão flutuante para foto com GPS em um toque, nota, áudio ou local; os itens esperam em Rascunhos (por operação ou caixa geral) e são atribuídos depois a um alvo, um a um ou em lote.
- **Atalhos** (v0.6): Nova foto, Marcar local, Gravar áudio e Registro rápido no ícone (Android) e URLs `#acao/…` para o app Atalhos do iPhone.
- **Etiquetas** (v0.6) nos alvos, com filtro na operação e na Busca, no CSV e nos relatórios.
- **Pendências** (v0.6) por alvo, com prazo, atrasadas destacadas na tela inicial e tela geral com filtros.
- **Duplicar operação como modelo e arquivar/desarquivar** (v0.6), com opção de incluir arquivadas na Busca e em Pendências.
- **Ditado por voz** (v0.6) nos campos de texto (reconhecimento de fala do navegador).
- **Leitura de documento e de placa** (v0.6, OCR no aparelho com tesseract.js em português): RG/CNH com conferência de CPF, nascimento e filiação; placa antiga e Mercosul com correção por posição. O leitor é baixado no 1º uso e fica em cache.
- **Diário de vigilância** (v0.6): sessões com Chegou/Saiu em um toque, encontros, veículos (com leitura de placa) e observações, com hora e GPS; aparece na linha do tempo, no mapa e no relatório.
- **Rotas** (v0.6) para Waze, Google Maps e Apple Maps a partir dos locais e registros.
- **Régua** (v0.6) para medir distâncias no mapa.
- **Trajeto gravado** (v0.6) por GPS, com distância e duração, no mapa, no diário e no relatório.
- **Cruzamentos de telefones e placas** (v0.6): avisa quando o mesmo telefone (8 últimos dígitos + DDD, com ou sem 9/+55/operadora) ou a mesma placa (antiga = Mercosul) aparece em alvos diferentes ou no diário de vigilância; alertas na ficha, tela Cruzamentos (com arquivadas opcionais) e seção no relatório PDF.
- **Segurança**: trava automática, bloqueio progressivo após erros, **modo discreto**, **PIN de pânico** (cofre falso ou apagamento) e **Face ID / biometria** via WebAuthn (PRF quando disponível; o PIN é sempre a chave-mestra).

## Arquivos

`index.html`, `style.css`, `app.js`, `sw.js`, `manifest.json`, ícones e `lib/` (Leaflet 1.9.4, jsPDF, tesseract.js com `tess-core/` e `tessdata/por.traineddata` — licença em `lib/tesseract.LICENSE.md`). Sem build e sem dependências externas em tempo de execução, exceto os blocos do mapa, a busca de endereços (Nominatim) e o ditado (serviço de fala do sistema).

Cache offline: `opsvault-v7` (arquivos do app, pré-carregados), `opsvault-ocr-t7` (OCR, guardado no 1º uso) e `opsvault-tiles` (blocos do mapa); os dois últimos sobrevivem às atualizações.

> Antes de usar em serviço, confirme a política da sua instituição e a LGPD para dados de investigação.
