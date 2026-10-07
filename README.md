# OpsVault Mobile

Cofre de operações criptografado (PWA) — **by @aiforge.team** · versão **v0.8**

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
- **Formato ordenado com IA** (v0.8): na tela de extração, copie uma instrução pronta, cole numa IA (de preferência institucional) junto com o texto, foto ou PDF e cole a resposta; no formato `CAMPO: valor` (linhas com `|`, blocos ou JSON) o app lê cada campo **exatamente**, com selo “Formato ordenado reconhecido”, avisos de CPF inválido e “(incerto)”, redes sociais e observações.
- **Texto “Campo: valor” em qualquer ordem** (v0.8): rótulos como `Nome:`, `CPF:`, `RG:`, `Mãe:`, `Pai:`, `Endereço:`, `Placa:`, `Telefone:` são reconhecidos em qualquer ordem e têm prioridade sobre a adivinhação no texto livre.
- **Ler CNH por modelo, com moldura** (v0.8): câmera traseira ao vivo com moldura na proporção da CNH (ou foto do álbum), ajuste dos 4 cantos e endireitamento, OCR **campo a campo** nas posições do modelo (nome, doc. identidade/órgão/UF, CPF, nascimento, filiação, nº registro, validade, categoria) com filtro de caracteres e **% de confiança** por campo; reserva com leitura da página inteira; também em “Ler documentos em lote”. Posições estimadas do layout oficial — sempre conferir.
- **CNH digital em PDF** (v0.8): PDF exportado da Carteira Digital de Trânsito/gov.br é reconhecido pelos rótulos da camada de texto e lido pela posição de cada rótulo (selo “CNH digital reconhecida”); PDF digitalizado pode ser lido pela moldura da CNH. Tudo passa pela conferência antes de criar alvos.
- **Extrair alvos de texto, PDF e Word** (v0.7): cole um BO, relatório ou mensagem de WhatsApp, ou escolha um PDF (com texto ou digitalizado, via OCR), Word `.docx` ou `.txt`; o app encontra nomes, vulgo, CPF (com verificação), RG, nascimento, filiação, telefones, placas e endereços e monta pessoas para **conferir** (editar, mover dados, juntar, duplicados por CPF/RG/nome) antes de criar ou completar alvos. Texto de origem opcional como anotação, com SHA-256.
- **Fotos em lote pelo nome do arquivo** (v0.7): várias fotos de uma vez, ligadas ao alvo pelo CPF/RG (`52998224725_2.jpg`, `529.982.247-25.jpg`), nome ou vulgo no nome do arquivo; tabela de conferência (trocar alvo ou não importar), data/GPS do EXIF, SHA-256 do original, capa e carimbo opcionais.
- **Leitura de documentos em lote** (v0.7): várias fotos de RG/CNH lidas uma a uma no aparelho (OCR), com progresso e Cancelar/Continuar; cartões com nome, CPF, RG, nascimento e filiação para conferir, juntar e checar duplicados; a imagem vira a foto do documento do alvo (criptografada, com SHA-256).
- **Segurança**: trava automática, bloqueio progressivo após erros, **modo discreto**, **PIN de pânico** (cofre falso ou apagamento) e **Face ID / biometria** via WebAuthn (PRF quando disponível; o PIN é sempre a chave-mestra).

## Arquivos

`index.html`, `style.css`, `app.js`, `sw.js`, `manifest.json`, ícones e `lib/` (Leaflet 1.9.4, jsPDF, tesseract.js com `tess-core/` e `tessdata/por.traineddata` — licença em `lib/tesseract.LICENSE.md`; pdf.js 3.11 legacy em `lib/pdfjs/` — licença Apache 2.0 em `lib/pdfjs/LICENSE`; fflate em `lib/fflate.min.js` — licença MIT em `lib/fflate.LICENSE`). Sem build e sem dependências externas em tempo de execução, exceto os blocos do mapa, a busca de endereços (Nominatim) e o ditado (serviço de fala do sistema).

Cache offline: `opsvault-v8` (arquivos do app, pré-carregados), `opsvault-ocr-t7` (OCR, guardado no 1º uso), `opsvault-lib-t1` (pdf.js e fflate, guardados no 1º uso) e `opsvault-tiles` (blocos do mapa); os três últimos sobrevivem às atualizações.

> Antes de usar em serviço, confirme a política da sua instituição e a LGPD para dados de investigação.
