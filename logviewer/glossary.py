"""Glossario das siglas que aparecem em log e logcat do Android.

Alimenta as dicas de contexto da tabela (colunas, niveis e TAGs conhecidas) e o
painel de ajuda. Serve para quem le o log nao precisar decorar o que e AMS, TID
ou WTF.
"""

# Colunas da tabela de log.
COLUMNS = {
    "PID": ("Process Identifier",
            "Identificador do processo. Numero unico que o sistema atribui a cada "
            "processo ativo. Fechar e reabrir o app gera um PID novo."),
    "TID": ("Thread Identifier",
            "Identificador da thread. Um mesmo processo (PID) pode ter varias "
            "threads em paralelo. TID igual ao PID indica a thread principal."),
    "UID": ("User Identifier",
            "Identificador de usuario. Cada app e um 'usuario' isolado do Linux; "
            "o UID define as permissoes de acesso. Pode vir numerico (10032) ou "
            "simbolico (radio, system, u0_a32)."),
    "L.": ("Level", "Nivel de prioridade da mensagem."),
    "Hora": ("Timestamp", "Momento em que a linha foi registrada."),
    "Tag": ("Tag",
            "Rotulo do componente que emitiu a mensagem, normalmente o nome da "
            "classe ou do servico."),
}

# Niveis de prioridade do logcat.
LEVELS = {
    "V": ("Verbose", "Registro detalhado. Depuracao de baixo nivel, "
                     "geralmente removida em versoes de producao."),
    "D": ("Debug", "Mensagens de depuracao usadas durante o desenvolvimento "
                   "para entender o fluxo do codigo."),
    "I": ("Info", "Informacoes gerais sobre estado ou progresso "
                  "(ex: 'Conexao estabelecida')."),
    "W": ("Warning", "Algo inesperado aconteceu, mas nao interrompeu a execucao."),
    "E": ("Error", "Erro grave que impediu alguma funcionalidade de funcionar."),
    "F": ("Fatal / WTF", "Erro critico que derruba o app. WTF significa "
                         "'What a Terrible Failure', gerado por Log.wtf()."),
    "A": ("Assert", "Falha de assercao. Na pratica o Android registra "
                    "Log.wtf() como F."),
    "S": ("Silent", "Nivel que suprime toda a saida."),
}

# Servicos e componentes do sistema, indexados pela sigla e pelos nomes de TAG
# com que aparecem no logcat.
COMPONENTS = {
    "AMS": ("Activity Manager Service",
            "Gerencia o ciclo de vida dos aplicativos e suas activities.",
            ("ActivityManager", "ActivityManagerService", "ActivityTaskManager")),
    "WMS": ("Window Manager Service",
            "Controla as janelas exibidas na tela.",
            ("WindowManager", "WindowManagerService")),
    "PMS": ("Package Manager Service",
            "Gerencia os aplicativos instalados e suas permissoes.",
            ("PackageManager", "PackageManagerService")),
    "PWM": ("Phone Window Manager",
            "Trata teclas fisicas, rotacao e comportamento da janela do sistema.",
            ("PhoneWindowManager",)),
    "IMS": ("Input Method Service",
            "Servico de metodo de entrada (teclado virtual).",
            ("InputMethodManager", "InputMethodManagerService")),
    "SF": ("SurfaceFlinger",
           "Compoe as camadas graficas e as envia para a tela.",
           ("SurfaceFlinger",)),
    "ART": ("Android Runtime",
            "Maquina de execucao dos apps, sucessora da Dalvik.",
            ("art", "dalvikvm")),
    "RIL": ("Radio Interface Layer",
            "Camada entre o Android e o modem: chamadas, SMS e dados moveis.",
            ("RIL", "RILJ", "RilRequest")),
    "AOSP": ("Android Open Source Project",
             "Base aberta do Android, sem as camadas do fabricante.", ()),
}

# Erros e conceitos que aparecem no texto das mensagens.
CONCEPTS = {
    "ANR": ("Application Not Responding",
            "A tela travou por mais de 5 segundos porque a thread principal "
            "ficou bloqueada. Procure o que rodava na main thread no momento."),
    "OOM": ("Out Of Memory",
            "O app consumiu toda a RAM disponivel para ele. Costuma vir "
            "acompanhado de OutOfMemoryError ou do lowmemorykiller."),
    "GC": ("Garbage Collector",
           "Coletor de lixo: libera a memoria que o app nao usa mais. GC "
           "frequente e sinal de pressao de memoria."),
    "NDK": ("Native Development Kit",
            "Ferramentas para escrever parte do app em C/C++. Crashes de "
            "codigo nativo geram tombstone, nao stack trace Java."),
    "SDK": ("Software Development Kit",
            "Conjunto de ferramentas e bibliotecas do Android. O nivel de API "
            "identifica a versao."),
    "JNI": ("Java Native Interface",
            "Ponte entre o codigo Java e o codigo nativo."),
    "SELinux": ("Security-Enhanced Linux",
                "Controle de acesso obrigatorio do kernel. Bloqueios aparecem "
                "como 'avc: denied'."),
    "IPC": ("Inter-Process Communication",
            "Comunicacao entre processos; no Android acontece via Binder."),
    "Binder": ("Binder",
               "Mecanismo de IPC do Android. 'Binder transaction failed' costuma "
               "indicar processo morto do outro lado."),
    "Tombstone": ("Tombstone",
                  "Despejo gerado por crash de codigo nativo, com sinal "
                  "(SIGSEGV, SIGABRT) e pilha das threads."),
    "WTF": ("What a Terrible Failure",
            "Registro de condicao que jamais deveria ocorrer, feito por "
            "Log.wtf(). Aparece no nivel F."),
    "Watchdog": ("Watchdog",
                 "Vigia do system_server: se um servico do sistema trava, ele "
                 "reinicia o processo — o aparelho parece reiniciar sozinho."),
    "Strict Mode": ("StrictMode",
                    "Detector de operacoes lentas (disco, rede) na thread "
                    "principal."),
    "Doze": ("Doze",
             "Modo de economia que suspende trabalho em segundo plano com o "
             "aparelho parado."),
    "ADB": ("Android Debug Bridge",
            "Ferramenta de linha de comando para conversar com o aparelho."),
}


def _entries():
    out = []
    for name, (full, desc) in COLUMNS.items():
        out.append({"group": "colunas", "sigla": name, "nome": full,
                    "desc": desc, "tags": []})
    for name, (full, desc) in LEVELS.items():
        out.append({"group": "niveis", "sigla": name, "nome": full,
                    "desc": desc, "tags": []})
    for name, (full, desc, tags) in COMPONENTS.items():
        out.append({"group": "componentes", "sigla": name, "nome": full,
                    "desc": desc, "tags": list(tags)})
    for name, (full, desc) in CONCEPTS.items():
        out.append({"group": "conceitos", "sigla": name, "nome": full,
                    "desc": desc, "tags": []})
    return out


GROUP_LABELS = {
    "colunas": "Colunas da tabela",
    "niveis": "Niveis de prioridade",
    "componentes": "Componentes do sistema",
    "conceitos": "Erros e conceitos",
}

# TAG do logcat -> sigla, para a dica de contexto na coluna Tag.
TAG_INDEX = {
    tag: sigla
    for sigla, (_, _, tags) in COMPONENTS.items()
    for tag in tags
}


def as_dict():
    return {
        "entries": _entries(),
        "groups": GROUP_LABELS,
        "tag_index": TAG_INDEX,
    }
