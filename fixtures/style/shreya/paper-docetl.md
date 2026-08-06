\usesmartdiagramlibrary 
 additions

 \pdfcolInitStack tcb@breakable

# 
 DocETL : Agentic Query Rewriting and Evaluation 
 for Complex Document Processing

 
 
 Shreya Shankar
 
 UC Berkeley 
 
 shreyashankar@berkeley.edu 
 
 ,  
 Aditya G. Parameswaran
 
 UC Berkeley 
 
 adityagp@berkeley.edu 
 
  and  
 Eugene Wu
 
 Columbia University 
 
 ewu@cs.columbia.edu 
 

 
###### Abstract.

 Analyzing unstructured data, such as complex documents,
has been a persistent challenge in data processing.
Large Language Models (LLMs) have shown promise in this regard,
leading to recent proposals for declarative
frameworks
for LLM-powered unstructured data processing.
However, these frameworks
focus on reducing cost when executing user-specified
operations using LLMs, rather than improving accuracy,
executing most operations as-is.
This is problematic
for complex tasks and data, where LLM outputs for user-defined operations
are often inaccurate, even with optimized prompts.
For example, an LLM may struggle to identify
 all instances of specific clauses, like force majeure or indemnification, in lengthy legal documents, requiring decomposition of the data, the task, or both. 

 We present DocETL , a system that optimizes complex document processing pipelines,
while accounting for LLM shortcomings. DocETL offers a declarative interface for users to define such pipelines and uses an agent-based framework to automatically optimize them,
leveraging novel agent-based rewrites (that we call rewrite directives ) and an optimization and evaluation framework that we introduce.
We introduce (i) logical rewriting of pipelines, tailored for LLM-based tasks, (ii) an agent-guided plan evaluation mechanism that synthesizes and orchestrates task-specific validation prompts, and (iii) an optimization algorithm that efficiently finds promising plans, considering the time constraints of LLM-based plan generation and evaluation. Our evaluation on three different unstructured document analysis tasks demonstrates that DocETL finds plans with outputs
that are 1.34 1.34 1.34 to 4.6 × 4.6\times higher quality (e.g., more accurate, comprehensive) than well-engineered baselines, addressing a critical gap in existing declarative frameworks for unstructured data analysis.
DocETL is open-source at docetl.org , and as of October 2024, has amassed over 800 GitHub Stars,
with users spanning a variety of domains. 

 † † copyright: none † † journalyear: 2024 † † doi: XXXXXXX.XXXXXXX 
 
## 
 1. Introduction

 
 Figure 1. Optimization for a pipeline designed to accomplish the task in Example   1.1 . The diagram illustrates the system mid-optimization of the initial map operation. DocETL employs LLMs to synthesize new plans using novel rewrite directives. The process begins with an LLM verifier determining if an operation is sufficiently optimized. If not, rewriting continues. Notably, when a new operation is synthesized as part of a rewrite, it undergoes immediate opportunistic optimization, as shown by the nested “Apply Rewrites (Agent)” rectangles. 
 
 
 Large Language Models (LLMs) have taken the world of
data management by storm, with emergent applications
ranging from data integration and discovery,
to database tuning, to query optimization, to data cleaning  (Fernandez et al . , 2023 ) .
Moving beyond relational data, there is a growing
interest in applying LLMs to process unstructured data via a declarative
interface  (Lin et al . , 2024 ; Patel et al . , 2024 ; Liu et al . , 2024b ; Anderson et al . , 2024 ) , all
in the last few months.
These systems
largely focus on reducing cost, while
keeping accuracy almost the
same.
However, for many real-world tasks, that
we refer to as complex document processing tasks,
accuracy can be a significant bottleneck.
Here, complexity can stem from the
documents or the nature of the processing task, or
both.
Consider this scenario from our collaborators
on the Police Records Access Project 1 1 1 https://bids.berkeley.edu/california-police-records-access-project :

 
###### Example 1.1 (Police Misconduct Identification).

 
 Journalists at the Investigative Reporting Program at Berkeley
want to analyze a large corpus of police records,
obtained through records requests,
to uncover patterns of officer misconduct and potential procedural violations.
These police records are heterogeneous documents,
encompassing police reports, transcripts of court hearings,
internal affairs reports,
medical examiner reports, and other case files, often
amounting to hundreds of pages, each.
This analysis involves identifying and summarizing
pertinent information from each document,
aggregating information across all documents
for each officer to identify behavioral patterns,
and generating summaries of officers’ conduct with flags for concerning trends.

 
 Example   1.1 is representative of
complex document processing tasks
common
across many domains spanning law, medicine,
and the social sciences.
Consider a simpler version of this task,
where we just want a summary
of the role of each officer
mentioned in each complex police record
document, each with hundreds of pages,
This task can be expressed as a
single-step map 
operation applied to the OCR output per document, in one LLM call,
with a user-provided
prompt defining terms like “misconduct.”
All existing systems  (Lin et al . , 2024 ; Patel et al . , 2024 ; Liu et al . , 2024b ; Anderson et al . , 2024 ) 
would simply execute the map operation, as is, per document,
in a single LLM call.
That is, they assume user-defined operations
will yield sufficiently accurate results when executed by the LLM ,
and focus primarily on reducing cost, while maintaining accuracy.
However,
this map operation may provide poor accuracy for multiple reasons.
First, the document in question may exceed the LLM’s context limit.
And even if it fits within this limit,
the LLM output may omit certain
instances of misconduct, or
include spurious information.
Recent work has shown that
LLM performance degrades considerably as length increases  (Levy et al . , 2024 ) ,
because they can be distracted  (Shi et al . , 2023 ) or
pay more attention to certain portions  (Liu et al . , 2024a ) , failing to gain a holistic understanding  (Bai et al . , 2023 ; Tang et al . , 2023 ; Zhao et al . , 2024b ; Jiang et al . , 2023 ) .
Simultaneous
theoretical work has shown that this degradation is attributable
to limits in the transformer architecture  (Peng et al . , 2024 ; Sui et al . , 2024 ; Kalai and Vempala, 2024 ) .
While one could apply prompt compilation techniques  (Khattab et al . , 2024 ; Wen et al . , 2024 ) 
to identify a better prompt,
this relies on the presence of examples, which are
either not present or are too long to include (e.g.,
an example document with hundreds of pages)—but
irrespective do not fix the underlying challenges with LLMs performing
a complex task on complex documents.

 
 Our key insight is that
the quality of LLM outputs is not often not adequate
for complex data processing—we therefore can’t simply treat the existing user-provided operators as a given. Instead,
 we need to consider novel rewrites that decompose
complex but error-prone operator(s)
into a sequence of simpler and more accurate operators. 
For our map example,
a different sequence of operators can increase accuracy.
One such example is map → → \rightarrow map , where the first map
is tasked with removing all portions of
each input document that do not pertain
to misconduct (e.g., medical examiner reports),
and the second map is the single-step map above.
Or we could replace the first map
with one that summarizes each sequence of k 𝑘 k paragraphs into one,
keeping the second map as is.
Yet another option is to replace the single-step map with
what we call the split → → \rightarrow gather → → \rightarrow map → → \rightarrow reduce pattern that
splits the document into contiguous chunks;
for each chuck, “gather” k 𝑘 k neighboring chunks before/after as context or background
to be included into a prompt,
and generate per-officer summaries using its 2 ​ k 2 𝑘 2k neighbors as background context (map);
and finally, a global summarization across all chunks (reduce).

 
 However, we cannot expect a user to rewrite their pipeline of operators
into many alternate pipelines, and determine the one that has the
best performance across accuracy, latency, cost, and other
task-specific requirements .
The previous paragraph introduced three out of a multitude of potential rewrites,
each of which could
be (recursively) applied to each operator (or operators) in a pipeline.
Even the two rewrites above
present a seemingly infinite set of options.
For example, for the map → → \rightarrow map pipeline,
there are many alternatives for what the first map could do,
and many different associated prompts.
Even if we decide to use the first map to summarize k 𝑘 k chunks at a time,
determining the right value for k 𝑘 k is challenging.
Likewise for the split → → \rightarrow gather → → \rightarrow map → → \rightarrow reduce pipeline.
Add this to the fact that we’re just focusing on the first step
of the overall goal in Example   1.1 ,
which is to summarize misconduct across all documents.
To do so, we may need to apply a reduce 
operation across documents
to group and summarize misconduct extractions by officer name.
However, the same officer may be extracted as
“Officer Smith” in one document and “J. Smith” in another, resulting in separate and incomplete summaries for what should be a single officer  (Parameswaran et al . , 2023 ) .
It’s not entirely clear how one would implement
this form of entity resolution.
Moreover, additional context from the original document(s) may be necessary
to determine if the two officers with the same name are actually identical.
Or, the LLM might struggle to recognize that multiple files can correspond to the same case, leading to overrepresentation of certain incidents in the misconduct summaries  (van Schaik and Pugh, 2024 ) .
 Overall, even an LLM expert would require
extensive experimentation to find a
sufficiently accurate initial pipeline,
as the approach is highly dependent
on the specific data, task, and LLM capabilities. 
This complexity underscores the need for a system
that can automatically explore and evaluate different
task decomposition strategies
to find the most effective pipeline
for a given task and dataset.

 
 We present DocETL , our first attempt at developing
a declarative system optimized for complex document processing .
 DocETL provides a declarative YAML-based interface for users
to author pipelines with operators specific to the LLM setting,
including two new ones: resolve for entity resolution, and gather to maintain context when processing document chunks.
Users can specify their complex document processing pipeline
at a high level with DocETL decomposing, rewriting, and optimizing
the pipeline.
To do so, DocETL relies on an agent-based framework 
to rewrite user-specified pipelines into alternative ones,
as shown in Figure   1 .
However, rather than simply relying on agents as-is, which can be error-prone, we
 guide them to rewrite query plans using novel rewrite directives that we’ve identified.
We call these directives instead of rules
because they are more abstract,
and are to be interpreted by LLMs
in the context of particular tasks and data
characteristics, with infinitely many concrete instantiations of each directive.
We further leverage an agentic framework to
 evaluate the resulting pipelines.
Since evaluation can be expensive,
we develop an optimization approach
inspired by Cascades  (Graefe, 1995 ) ,
where we use a top-down rule-based strategy
to generate and evaluate a space of equivalent plans,
opting to opportunistically decompose (or rewrite)
operators that are complex and error-prone
into simpler ones.
This declarative approach relieves
the burden on the developer,
who can focus on evaluating the outputs of the optimized pipeline,
and focus on high-level constraints and logic,
with the flexibility to drill-down
any stage of the pipeline to inspect
intermediates and make further changes, as needed.

 
 DocETL is open-source and available on GitHub 2 2 2 https://github.com/ucbepic/docetl .
As of October 2024, it has already amassed 800+ GitHub stars ,
and has been used for pipelines ranging from domain-specific analysis (e.g., legal, climate science) to enterprise and personal productivity (e.g., analyzing customer support tickets, emails);
over 230 users have joined the corresponding Discord server.

 
 We make the following contributions in this paper:

 
 
 
 (1) 
 
 Novel Rewrite Directives and Agent-Driven Rewriting: We identify 13 new rewrite directives designed for LLM-based operators,
addressing challenges unique to complex document processing.
Unlike traditional database rewrite rules,
we leverage LLM agents to implement these directives.
When a rule applies to a portion of a pipeline,
agents synthesize appropriate prompts and parameters for new operations.
For example, when decomposing a “summarize instances of misconduct” operation into multiple ones, an agent might create two steps: first, “list instances of misconduct given specific types (e.g., excessive force),”
followed by “summarize each listed instance,”
crafting suitable prompts for each new operation.

 
 (2) 
 
 Agent-Driven Plan Assessment: We also use LLM agents to both
synthesize task-specific validation prompts for each operation, and
use these to assess output quality.
For instance, to verify a misconduct summary,
an agent might create a prompt asking,
”Does this summary include all instances of misconduct from the original document?” Or, “Do all mentioned instances exist in the original document?”
The agents then execute plans on sample data
and evaluate outputs using these custom prompts,
enabling DocETL to assess plan effectiveness in a
data-specific and task-specific manner.
This entire process happens without the user having to provide
or manually validate examples.

 
 (3) 
 
 Opportunistic Sub-plan Optimization: 
Unlike traditional query optimizers that generate
and evaluate a broad range of possible plans  (Chaudhuri, 1998 ) , we leverage an opportunistic recursion strategy as shown in Figure   1 :
when we use a rewrite directive to decompose operators
into new ones, we immediately attempt to optimize 
each new operator.
We first check if each such
operator is sufficiently accurate,
based on the validation as described previously.
If sufficiently accurate, we no longer optimize that operator,
focusing instead on rewriting other operators.
Thus, we opportunistically decompose (or apply rewrite directives to) operators
that are not sufficiently accurate,
Such an approach is necessary because enumerating and
evaluating all possible plans would be prohibitively
time-consuming due to the inherent latencies in LLM operations.

 

 
 We describe DocETL ’s programming model and operators in Section  2 ;
our new LLM-centric rewrite directives in Section  3 ,
the agentic optimizer that applies them, and evaluates the
resulting plans, as well
as the overall framework for optimization in Section  4 .
We present our initial evaluation in Section  5 , where we demonstrate that across three unstructured document analysis tasks, DocETL finds plans with outputs of 1.5 to 4.6 × \times higher quality (e.g., more accurate, comprehensive) than hand-engineered baselines. We then reflect on next steps in Section  6 , and discuss related work in Section  7 .

 
 
## 
 2. DocETL DSL and Operators

 
 Here, we provide an overview of DocETL ’s programming model and operators.

 
### 
 2.1. Programming Model

 
 Documents and Datasets. DocETL processes collections of documents. A document comprises a set (or dictionary) of key (or equivalently, attribute)-value pairs, represented as a JSON object. For example, a police record could be a set of key-value pairs, where one key corresponds to the OCR output of the PDF,
while other keys could capture metadata such as responding agency, file name, or creation date.
A collection of documents or dataset , is a list of such documents, represented as a JSON array. This choice of data representation allows for flexibility in handling various data types and degrees of structure, while enabling easy referencing of data within operation prompts. Documents can include nesting, e.g., a police record could have a related_documents key that contains an array of other dictionary-type objects, such as witness statements or evidence logs, each with their own set of key-value pairs.

 
 DocETL DSL. DocETL employs YAML as its domain-specific language (DSL) for defining data processing pipelines.
We chose YAML for several reasons.
First, YAML is flexible in accommodating complex multi-line
prompts and examples, as well as output schemas and validation mechanisms,
while intermixing formatting with arguments in Jinja  (Pallets, 2024 ) .
Second, YAML is human-readable and doesn’t require extensive coding expertise.
Third, it is commonly used in industry for describing data pipelines (Apache Airflow, dbt, Prefect)
and services (Kubernetes, Docker, Circle/Gitlab CI/CD).
Finally, YAML serves as a simple intermediate format for
representing the DocETL optimized pipelines
for human inspection, as well as for
the no-code interface we plan to build,
where users will provide data and natural language descriptions,
with DocETL generating optimized pipelines.
That said, our optimization techniques are not dependent on YAML
and are also applicable to other frameworks.

 
 DocETL Pipelines. A typical DocETL   pipeline , expressed in YAML, describes a sequence of operations . Each operation specifies its operator type, input source, prompt template, and output schema. The input source can be either the original dataset or the output of a previous operator. A global default model can be specified, and individual operators can override this setting. The pipeline begins with dataset definitions, which serves as the initial input. As operators process data, they generate outputs conforming to their schemas, which subsequent operators can then use. This structure allows for flexible and modular pipeline composition while maintaining data consistency between steps. DocETL also allows for flexible model specification,
with a default model set for the entire pipeline,
and the option to specify different models per operation.

 
 Fault Tolerance. When executing an LLM-powered operator for many input documents in a pipeline, some operations may occasionally fail to adhere to the given prompt.
While prior work assumes
reliability in LLM outputs  (Anderson et al . , 2024 ; Liu et al . , 2024b ; Patel et al . , 2024 ) , DocETL explicitly addresses this variability. For each operator, DocETL ’s API allows users to specify validations as Python statements that evaluate to true or false. These statements can reference document attributes, including those in the output schema. If any of the validation statements fail, a retry is triggered, and DocETL provides context about the failing validation in the subsequent call to the LLM. This context-aware retry mechanism increases the likelihood of success in subsequent attempts, since the LLM is informed about its previous mistake and can fix its output accordingly.

 
 
### 
 2.2. Operators

 
 Table 1. Definitions of DocETL operators. D 𝐷 D represents a dataset, d 𝑑 d represents a document. LLM refers to a large language model used for evaluating conditions or performing transformations. d ​ [ k ] 𝑑 delimited-[] 𝑘 d[k] denotes the value of attribute k 𝑘 k in document d 𝑑 d . π K ​ ( D ) subscript 𝜋 𝐾 𝐷 \pi_{K}(D) represents the projection of dataset D 𝐷 D on key set K 𝐾 K . 
 
 
 
 Operation 
 Definition 
 
 
 Notes 
 
 
 
 
 
 
 Map 
 D → { d ∪ π ​ ( d ) ∣ d ∈ D } → 𝐷 conditional-set 𝑑 𝜋 𝑑 𝑑 𝐷 D\rightarrow\{d\cup\pi(d)\mid d\in D\} 
 
 
 π 𝜋 \pi is an LLM-powered projection 
 
 
 
 
 Parallel Map 
 D → { d ∪ ⋃ i = 1 n π i ​ ( d ) ∣ d ∈ D } → 𝐷 conditional-set 𝑑 superscript subscript 𝑖 1 𝑛 subscript 𝜋 𝑖 𝑑 𝑑 𝐷 D\rightarrow\{d\cup\bigcup_{i=1}^{n}\pi_{i}(d)\mid d\in D\} 
 
 
 π 1 , … , π n subscript 𝜋 1 … subscript 𝜋 𝑛 \pi_{1},\ldots,\pi_{n} are independent LLM-powered projections operating on the same document 
 
 
 
 
 Unnest (Array) 
 D → { { d ∖ { a } ∪ { a : v } ∣ v ∈ d ​ [ a ] } ∣ d ∈ D } → 𝐷 conditional-set conditional-set 𝑑 𝑎 conditional-set 𝑎 𝑣 𝑣 𝑑 delimited-[] 𝑎 𝑑 𝐷 D\rightarrow\{\{d\setminus\{a\}\cup\{a:v\}\mid v\in d[a]\}\mid d\in D\} 
 
 
 a 𝑎 a is an array-valued attribute; No LLM used 
 
 
 
 
 Unnest (Dict) 
 D → { d ∪ d ​ [ a ] ∣ d ∈ D } → 𝐷 conditional-set 𝑑 𝑑 delimited-[] 𝑎 𝑑 𝐷 D\rightarrow\{d\cup d[a]\mid d\in D\} 
 
 
 a 𝑎 a is a dict-valued attribute; No LLM used 
 
 
 
 
 Reduce 
 D → { γ ​ ( { d ∈ D ∣ d ​ [ k ] = v } ) ∣ v ∈ π K ​ ( D ) } → 𝐷 conditional-set 𝛾 conditional-set 𝑑 𝐷 𝑑 delimited-[] 𝑘 𝑣 𝑣 subscript 𝜋 𝐾 𝐷 D\rightarrow\{\gamma(\{d\in D\mid d[k]=v\})\mid v\in\pi_{K}(D)\} 
 
 
 K 𝐾 K is the reduce key set, γ 𝛾 \gamma is an LLM-powered aggregation 
 
 
 
 
 Filter 
 D → { d ∈ D ∣ ϕ ​ ( d ) } → 𝐷 conditional-set 𝑑 𝐷 italic-ϕ 𝑑 D\rightarrow\{d\in D\mid\phi(d)\} 
 
 
 ϕ italic-ϕ \phi is an LLM-evaluated condition 
 
 
 
 
 Resolve 
 D → { d ​ [ r ↦ γ ​ ( { d j ∈ D ∣ θ ​ ( d ​ [ r ] , d j ​ [ r ] ) } ) ] ∣ d ∈ D } → 𝐷 conditional-set 𝑑 delimited-[] maps-to 𝑟 𝛾 conditional-set subscript 𝑑 𝑗 𝐷 𝜃 𝑑 delimited-[] 𝑟 subscript 𝑑 𝑗 delimited-[] 𝑟 𝑑 𝐷 D\rightarrow\{d[r\mapsto\gamma(\{d_{j}\in D\mid\theta(d[r],d_{j}[r])\})]\mid d\in D\} 
 
 
 r 𝑟 r is the resolve key, θ 𝜃 \theta is an LLM-evaluated equality condition for pairwise comparison, γ 𝛾 \gamma is an LLM-evaluated resolution function that consolidates matched entries and returns a new value for r 𝑟 r 
 
 
 
 
 Equijoin 
 D 1 × D 2 → { d 1 ∪ d 2 ∣ d 1 ∈ D 1 , d 2 ∈ D 2 , θ ​ ( d 1 , d 2 ) } → subscript 𝐷 1 subscript 𝐷 2 conditional-set subscript 𝑑 1 subscript 𝑑 2 formulae-sequence subscript 𝑑 1 subscript 𝐷 1 subscript 𝑑 2 subscript 𝐷 2 𝜃 subscript 𝑑 1 subscript 𝑑 2 D_{1}\times D_{2}\rightarrow\{d_{1}\cup d_{2}\mid d_{1}\in D_{1},d_{2}\in D_{2},\theta(d_{1},d_{2})\} 
 
 
 θ 𝜃 \theta is an LLM-evaluated equality condition 
 
 
 
 
 Split 
 D → ⋃ d ∈ D { d 1 , … , d n } → 𝐷 subscript 𝑑 𝐷 subscript 𝑑 1 … subscript 𝑑 𝑛 D\rightarrow\bigcup_{d\in D}\{d_{1},\ldots,d_{n}\} 
 
 
 Given split key k 𝑘 k and chunk size c 𝑐 c , where d i = ( d ∖ { k } ) ∪ { k : t i } subscript 𝑑 𝑖 𝑑 𝑘 conditional-set 𝑘 subscript 𝑡 𝑖 d_{i}=(d\setminus\{k\})\cup\{k:t_{i}\} , and { t 1 , … , t n } = chunk ​ ( d ​ [ k ] , c ) subscript 𝑡 1 … subscript 𝑡 𝑛 chunk 𝑑 delimited-[] 𝑘 𝑐 \{t_{1},\ldots,t_{n}\}=\text{chunk}(d[k],c) . chunk ​ ( d ​ [ k ] , c ) chunk 𝑑 delimited-[] 𝑘 𝑐 \text{chunk}(d[k],c) divides d ​ [ k ] 𝑑 delimited-[] 𝑘 d[k] into chunks of size c 𝑐 c . No LLM used. 
 
 
 
 
 Gather 
 D split → { d ∪ ω ​ ( d , D split ) ∣ d ∈ D split } → subscript 𝐷 split conditional-set 𝑑 𝜔 𝑑 subscript 𝐷 split 𝑑 subscript 𝐷 split D_{\text{split}}\rightarrow\{d\cup\omega(d,D_{\text{split}})\mid d\in D_{\text{split}}\} 
 
 
 Applied after Split, in cases where a downstream operator needs contextual information to process a chunk. ω 𝜔 \omega is the gather config specifying contextual information to include around chunk (e.g., previous chunks, next chunks). D split subscript 𝐷 split D_{\text{split}} is the dataset after a Split operation. 
 
 
 
 
 
 
 
 Here, we describe each operator in DocETL and any specific implementation details for executing them with LLMs. Table   1 summarizes our operators. Detailed syntax can be found in our documentation 3 3 3 https://www.docetl.org/ .
In the following, for succinctness of description,
we often conflate a document —which is a JSON object comprising key-value pairs and is the basic unit of processing in a dataset, with its textual content , which is typically a value for a specific key within
the key-value pairs represented by the document.

 
#### 
 2.2.1. Map

 
 The map operator applies an LLM-powered projection, also known as a semantic projection , to each document in the dataset. Let’s consider an example of a map operation:

 
 ⬇ 

 
 type : map 

 
 output :

 
 schema :

 
 misconduct : ” list [{ officer_name : str , misconduct_instance : str }]”

 
 prompt : |

 
 Analyze the following police record :

 
 {{ input . document }}

 

 
 Extract any instances of officer misconduct or procedural violations . For each instance , provide :

 
 1. The name of the officer involved 

 
 2. A brief description of the misconduct or violation 

 This operation, titled extract_officer_misconduct , processes each document independently, using the specified prompt. The output schema defines the expected structure of the output, in this case, an array of objects containing officer names and misconduct instances, each as key-value pairs. This flexible, semi-structured output format allows for varying numbers of misconduct instances per document.
 DocETL supports prompts using Jinja2 templates, as seen in the example where “ {{ input.document }} ” allows for insertion of the current document’s content. This functionality permits complex prompts that call for conditional logic (as we will see later).

 
 When applied, the map operation adds the new attributes specified in the output schema to the existing document, creating a version that contains both original and newly generated attributes by default. Users can override this behavior and return a subset of attributes by specifying a drop_keys list.

 
 DocETL also supports parallel maps, where multiple independent transformations can be applied simultaneously to each document. For example, if a user wanted to extract officer misconduct instances, and, in parallel, analyze department policies from each police report, one prompt could focus on extracting misconduct while another could summarize relevant policies. The operation would enrich each input document with new attributes corresponding to the outputs of each parallel transformation. While users could
technically use a map to specify a parallel map, in many cases, they already have prompt templates corresponding to two or more independent tasks on the same dataset, and this allows them to not have to coalesce their prompts together.

 
 
#### 
 2.2.2. Reduce

 
 The reduce operator aggregates information across multiple documents based on a set of user-specified keys, ultimately producing one output document per unique combination of attribute values. This operation is particularly useful for consolidating information spread across multiple related documents. For instance, for reducing police reports, the key set might include officer_name and incident_date , allowing for the grouping of all reports involving a specific officer on a particular date. Users can define prompt templates that access the grouped documents via {{ inputs }} (a list of documents sharing the same key values) and the specific key values for the current group via {{ reduce_key }} . By default, reduce operations are assumed to be associative, meaning that the order in which documents are processed does not affect the result. However, if the order is significant for a particular reduce task, users can specify associative: False in the operation definition.

 
 A challenge arises when any given group of documents is too large for the LLM to correctly process. One could use folding or hierarchical merging to process the data in manageable batches  (Patel et al . , 2024 ) . In folding, each input is serially processed, with an update to an accumulator (or aggregate), while hierarchical merging recursively aggregates inputs in a tree-like structure. DocETL currently implements a batched folding approach that starts with an empty accumulator and sequentially folds in batches of more than one element at a time. We chose folding because it permits non-associative reduce operations and maintains the original order of inputs. For example, when summarizing a textbook chapter, DocETL may chunk the text into sections (where a chunk is a portion of text that an LLM can reliably process), summarize each one, and then employ reduce to summarize the section summaries—a process that requires preserving the original reading order. DocETL automatically determines an optimal fold batch size when building the pipeline.

 
 To implement folding, users can provide (or DocETL can generate) a separate fold_prompt , which references the accumulated output and a batch of new inputs to fold into that output. We enhance the system prompt to allow the LLM to write extra notes to a scratchpad  (Nye et al . , 2021 ) —a technique that has been shown to improve accuracy by allowing it to maintain state. During each LLM call, we provide the current scratchpad along with the accumulated output and new inputs. The LLM returns both the updated accumulated output and scratchpad, which are passed to the next fold operation. An example is illustrated in Figure   2 for a task to identify names of people mentioned more than once across documents. The scratchpad tracks all mentions of names. As each batch is processed, the LLM updates the scratchpad with new mentions and adds to the accumulated output any person now mentioned more than once.

 
 Figure 2. Iterative folding in a reduce operation, illustrating the step-by-step evolution of both the scratchpad and accumulated output when processing multiple batches of documents. New input is integrated with the previous scratchpad state, updating mention counts and the intermediate output for entities mentioned multiple times across all processed documents. 
 
 
 
#### 
 2.2.3. Resolve

 
 The resolve operator is designed to canonicalize one or more attributes across documents within a dataset, and is particularly useful for consolidating information about the same entity that may appear with slight variations for subsequent grouping and aggregation. In our example of analyzing police misconduct, this operator can be used to reconcile slight variations in officer names extracted as part of the map operation described in  Section   2.2.1 . Here’s how it might be configured:

 
 
 ⬇ 

 
 type : resolve 

 
 comparison_prompt : — 

 
 Compare the following two officer records from police documents : 

 
 Officer 1 : 

 
 Name : {{ input1 . officer_name }}

 
 Mentioned in document : {{ input1 . document }}

 
 Officer 2 : 

 
 Name : {{ input2 . officer_name }}

 
 Mentioned in document : {{ input2 . document }}

 
 Are these names likely referring to the same officer ? Consider name similarity and context .

 
 resolution_prompt : — 

 
 The following names correspond to the same officer : 

 
 {% for input in inputs %}

 
 Name : {{ entry . officer_name }}

 
 {% endfor %}

 
 Provide a comprehensive officer name ( first and last ) that best represents all the matched entries .

 
 output : 

 
 schema : 

 
 officer_name : string 

 
 Overall, the user simply specifies how to detect variations, and how to canonicalize or resolve them. For the former, they use the “ comparison_prompt ” to check whether two officer names are the same. For the latter, they specify a “ resolution_prompt ” to consider a list (or cluster) of similar officer names and return a canonical name. DocETL then uses these two specifications to determine how best to compare and resolve officer names.

 
 After this operation is performed, the number of documents stays the same. The output schema specifies attributes to replace or add (if new) to each document. It’s worth noting this operation may follow an unnest ( Section   2.3.1 ) operation, which flattens nested data structures. For example, in our police misconduct pipeline, after unnesting, each document would have distinct officer_name and misconduct_instance keys, allowing for name resolution across all mentions in the dataset. Note also that users don’t need to explicitly define the resolve operation in their pipeline; DocETL will automatically synthesize them if needed
to ensure consistent entity references across the dataset.

 
 
#### 
 2.2.4. Other Operators

 
 Here, we describe other standard operators that DocETL supports;
technically, while all of these operators
could be implemented
using just map and reduce,
we include them in DocETL for convenience.
We plan to add
other operators in the future, such
as sorting.

 
 Filter. The filter operation independently retains documents from the input dataset based on a condition specified through a LLM prompt, which is a Jinja2 template that can reference one or more keys in the document.

 
 Equijoin. The equijoin operator joins two datasets, using an LLM to compare two documents. A comparison_prompt provides the prompt for comparison, designed to elicit a binary answer from the LLM, which must reference the documents as left and right . Note that the equijoin definition does not need to include an output schema, as left and right documents are merged to produce the outputs.

 
 
 
### 
 2.3. Auxiliary Operators

 
 Here, we discuss three essential operators that are not powered by LLMs, used as auxiliary steps to express complex tasks.

 
 Figure 3. Split-Gather Pipeline: Illustration of processing a single long document. The split operation divides a long document into manageable chunks. The gather operation then augments each chunk with relevant context from peripheral chunks. The image demonstrates three different ways of rendering chunk 3 (i.e., three different gather configurations): (i) including fractional parts of surrounding chunks, (ii) including the full content of the first chunk, and (iii) including summaries of all previous chunks. 
 
 
#### 
 2.3.1. Unnest

 
 The unnest operation expands either an array or a dictionary into individual elements. For example, suppose we’ve used a map to extract multiple officers mentioned in police interrogation transcripts, resulting in each document containing an array of officer names. To analyze the conduct of individual officers across multiple interrogations, we might want to create separate documents per officer.
To do so, we can use an unnest to create a new document for each element in the officer array, effectively flattening the data structure. We can then apply a reduce operation on the officer name, aggregating information about each one. Similarly, for nested dictionaries, unnest can extract specific nested attributes to the top level of the document, making them directly accessible for downstream operations.

 
 
#### 
 2.3.2. Split

 
 The split operator divides long text content into smaller chunks, facilitating subsequent processing per chunk. The core components include: the split key (the attribute in the document with the text to be split), a split method (based on token or delimiter), and method-specific parameters (e.g., delimiter or number of tokens per chunk). An example is as follows:

 
 
 ⬇ 

 
 type : split 

 
 split_key : document_text 

 
 method : token_count 

 
 method_kwargs : 

 
 num_tokens : 1000

 The above operation splits the document_text attribute into chunks of 1000 tokens each. The split operation produces several output attributes per chunk:

 
 
 
 (1) 
 
 The <split_key>_chunk attribute contains the chunk content. Here, the chunk content is stored in document_text_chunk .

 
 (2) 
 
 The <operation_name>_id attribute contains a unique identifier assigned to each original document (before splitting). In this case, it would be doc_splitter_id . All chunks from the same original document share the same ID.

 
 (3) 
 
 The <operation_name>_chunk_num attribute contains the sequential number of each chunk within its original document. Here, it would be doc_splitter_chunk_num .

 

 
 These additional attributes, particularly the document ID and chunk number, are used in downstream gather operations, to reassemble or process the chunks in context. Note that the new documents inherit the other attributes from the original.

 
 
#### 
 2.3.3. Gather

 
 The gather operation complements the split operation by augmenting individual chunks with peripheral information necessary for understanding the chunk’s content. Conceptually, the gather operator is similar to the window operator in traditional database systems, as both allow access to data beyond the current row or chunk, but gather is specifically designed for LLM-based processing of unstructured text.
To illustrate the gather operation, consider a long police interrogation transcript divided into chunks. A single chunk might contain pronouns like “he” or “she” without clearly defining the speakers, making it challenging to understand without context from previous chunks.
The gather operation allows flexible configuration of which peripheral information to include with each chunk. For example, a gather configuration might assemble context for each chunk as follows:

 
 
 ⬇ 

 
 type : gather 

 
 content_key : document_text_chunk 

 
 peripheral_chunks : 

 
 previous : 

 
 head : 

 
 count : 1

 
 content_key : document_text_chunk 

 
 middle : 

 
 content_key : document_text_chunk_summary 

 This particular configuration includes the full content of the document’s first chunk, summaries of intermediate chunks, and the current chunk itself.
 Figure   3 demonstrates different ways to render chunks. The gather operation is highly flexible in rendering contextual information, allowing for the inclusion of full chunks (as in (ii) ), portions of chunks (as in (i) ), or transformations (e.g., summaries) of chunks (as in (iii) ). Importantly, gather can be used in conjunction with map operations between the split and gather steps—allowing for the generation of additional context (such as summaries) that can be used to augment each chunk during the gather phase.

 
 The output of the gather operation adds a new attribute to each input document, containing the rendered chunk with its peripheral context, rendered with special tags that demarcate what is the chunk and what is peripheral context.
This approach ensures that each chunk is processed with necessary context, maintaining the coherence and structure of the original document even when split across multiple chunks. For additional details, see Appendix   A .

 
 
 
 
## 
 3. Rewrite Directives

 
 We now introduce the rewrite directives that DocETL currently supports.
We call these directives to indicate
that they are abstract frameworks that can be concretely
instantiated by LLM agents
in a multitude of ways, as opposed to rules , which
are much more concrete and complete.
These directives are primarily designed to optimize
the quality of outputs from DocETL pipelines
through logical decomposition of individual operations.
We focus on rewrite directives for map, reduce, and equijoin operators,
with filter operators also supported through the application of map rewrite directives.We organize our rewrite directives into three main categories: data decomposition, projection synthesis, and LLM-centric improvements.

 
 Throughout this section, we adopt the following notation: given two operators A 𝐴 A and B 𝐵 B , we denote their composition as A → B → 𝐴 𝐵 A\to B , where ( A → B ) ​ ( D ) = B ​ ( A ​ ( D ) ) → 𝐴 𝐵 𝐷 𝐵 𝐴 𝐷 (A\to B)(D)=B(A(D)) . For independent execution of operators, we use A ∥ B conditional 𝐴 𝐵 A\parallel B to indicate that A 𝐴 A and B 𝐵 B are executed on the same input, independently of each other. For readability, we may drop arguments for our operators—for instance, Map π ​ ( D ) subscript Map 𝜋 𝐷 \text{Map}_{\pi}(D) becomes Map π subscript Map 𝜋 \text{Map}_{\pi} . Similarly, we omit subscripts except in cases where the same operator appears in multiple places, allowing us to distinguish them. In the following, we refer to
the text content of the document, usually stored as one of the attributes, interchangeably with the document itself, for simplicity.

 
 As mentioned previously,
our rewrite directives are intentionally abstract,
serving as scaffolds for infinitely many specific rules.
The actual instantiation and application of these directives
are carried out by LLMs, which interpret the directives
in the context of specific tasks and data. Moreover, the benefits of applying these directives are also assessed by LLMs. We cannot know a-priori if a particular directive will help in a specific situation, or to what extent. The LLM agents evaluate the potential
impact of each directive based on the task requirements (i.e., prompts)
and data characteristics. In the following subsections, we will discuss each category of rewrite directives, their motivation, and why we believe they will be beneficial. We focus on the conceptual framework of these directives rather than their specific implementation details.

 
### 
 3.1. Data Decomposition

 
 Data decomposition is crucial
when dealing with large documents, or when there are
too many documents to fit in a prompt and get an accurate result for.
We present two categories of rewrite directive here:
 document chunking and multi-level aggregation .

 
#### 
 3.1.1. Document Chunking (Map)

 
 Large documents often exceed LLM capabilities, leading to incomplete or inconsistent results. Our primary rewrite directive for this case, which we call the split directive , is:

 
 
 
 (1) 
 
 Map x subscript Map 𝑥 \displaystyle\text{Map}_{x} 
 ⇒ (a) ​ Split → (b) Gather → (c) Map y → (d) Reduce ⇒ absent (a) absent Split (b) → Gather (c) → subscript Map 𝑦 (d) → Reduce \displaystyle\Rightarrow\overset{\text{{\color[rgb]{0,0,1}\definecolor[named]{pgfstrokecolor}{rgb}{0,0,1}(a)}}}{\hskip 14.22636pt}\text{Split}\xrightarrow{\text{{\color[rgb]{0,0,1}\definecolor[named]{pgfstrokecolor}{rgb}{0,0,1}(b)}}}\text{Gather}\xrightarrow{\text{{\color[rgb]{0,0,1}\definecolor[named]{pgfstrokecolor}{rgb}{0,0,1}(c)}}}\text{Map}_{y}\xrightarrow{\text{{\color[rgb]{0,0,1}\definecolor[named]{pgfstrokecolor}{rgb}{0,0,1}(d)}}}\text{Reduce} 
 
 
 
 
 Ignore the blue annotations for now.
This directive breaks down a complex map operation into:
splitting the document into multiple,
each corresponding to a chunk,
gathering peripheral context for each chunk,
applying a modified map operation
per chunk,
and applying reduce to the results.
The prompt corresponding to Map y subscript Map 𝑦 \text{Map}_{y} might explicitly include a statement
that only a portion of the original document is being processed.

 
 To provide more flexibility and optimization opportunities, we introduce smaller decomposition directives, for steps (a)–(d) above:

 

 
 (2) 
 
 (a)    Split 
 ⇒ Map → Split ⇒ absent Map → Split \displaystyle\Rightarrow\text{Map}\to\text{Split} 
 
 
 
 (3) 
 
 (b)  Split → Gather → (b)  Split Gather \displaystyle\text{{\color[rgb]{0,0,1}\definecolor[named]{pgfstrokecolor}{rgb}{0,0,1}(b)}\ \ Split}\to\text{Gather} 
 ⇒ Split → ( Map s ∥ Map h ) → Gather ⇒ absent Split → conditional subscript Map 𝑠 subscript Map ℎ → Gather \displaystyle\Rightarrow\text{Split}\to(\text{Map}_{s}\parallel\text{Map}_{h})\to\text{Gather} 
 
 
 
 (4) 
 
 (c)    Gather 
 ⇒ Gather → Filter ⇒ absent Gather → Filter \displaystyle\Rightarrow\text{Gather}\to\text{Filter} 
 
 
 
 (5) 
 
 (d)  Gather → Map → (d)  Gather Map \displaystyle\text{{\color[rgb]{0,0,1}\definecolor[named]{pgfstrokecolor}{rgb}{0,0,1}(d)}\ \ Gather}\to\text{Map} 
 ⇒ Gather → Map → Unnest ⇒ absent Gather → Map → Unnest \displaystyle\Rightarrow\text{Gather}\to\text{Map}\to\text{Unnest} 
 
 
 
 When splitting a document, three types of context prove particularly useful: document-level metadata, hierarchical information,
and summaries of neighboring chunks. The smaller decomposition directives address these and other aspects of document processing:

 
 
 
 • 
 
 Document-Level Metadata Extraction ( 2 ): This directive introduces a map operation immediately prior to splitting, enabling the extraction of metadata relevant to all chunks. For example, when analyzing a legal contract, we might extract the contract date, parties involved, and governing law from the first page, passing this information to every chunk to be rendered as part of a subsequent gather operation.

 
 • 
 
 Header Lineage Context and Summarization ( 3 ): This directive introduces two parallel map operations: Map h subscript Map ℎ \text{Map}_{h} for extracting hierarchical information (e.g., headers), and Map s subscript Map 𝑠 \text{Map}_{s} for generating summaries of chunks. As discussed in Section   2.3.3 , this allows us to provide each chunk with its relevant hierarchical context (e.g., parent headers for headers in a chunk) and/or a summary of preceding content, potentially improving the LLM’s ability to process the chunk in context.

 
 • 
 
 Chunk Filtering ( 4 ): Not all parts of a document may be relevant for processing. This directive introduces a filter step after gathering context, allowing us to exclude irrelevant chunks. This filter can be inferred; for instance, when processing a scientific paper, we might filter out acknowledgments or references sections if they’re not pertinent to the analysis task; but they could still be used as context for other chunks if needed.

 
 • 
 
 Flattening Nested Results ( 5 ): When processing chunks with gathered context, map might produce nested results. This directive introduces an unnest operation to flatten these results, simplifying downstream processing. For example, if each chunk produces a list of extracted entities, unnesting would flatten these lists into a single collection of entities across all chunks.

 

 
 
#### 
 3.1.2. Multi-Level Aggregation (Reduce)

 
 Large-scale aggregations can benefit from a hierarchical approach, aggregating data at a finer granularity before rolling up to the desired level. This decomposition is based on a semantic hierarchy in the data:

 

 
 (6) 
 
 Reduce K , x ⇒ Reduce K ∪ K ′ , y → Reduce K , z ⇒ subscript Reduce 𝐾 𝑥 subscript Reduce 𝐾 superscript 𝐾 ′ 𝑦 → subscript Reduce 𝐾 𝑧 \text{Reduce}_{K,x}\Rightarrow\text{Reduce}_{K\cup K^{\prime},y}\to\text{Reduce}_{K,z} 
 
 
 
 Here K 𝐾 K is the reduce key, e.g., K = {state} 𝐾 {state} K={\small\texttt{\{state\}}} , and K ′ superscript 𝐾 ′ K^{\prime} represents additional keys for finer granularity, e.g., K ′ = {city} superscript 𝐾 ′ {city} K^{\prime}={\small\texttt{\{city\}}} . y 𝑦 y and z 𝑧 z are LLM-powered aggregations for the sub-reduce and final reduce operations.
For example, when summarizing voting patterns by state from social media posts, we might first aggregate data by state and city ( Reduce { state , city } , y subscript Reduce state city 𝑦 \text{Reduce}_{\{\text{\tt state},\text{\tt city}\},y} ), then combine these city-level summaries to the state level ( Reduce { state } , z subscript Reduce state 𝑧 \text{Reduce}_{\{\text{\tt state}\},z} ). This approach can capture nuances that might be lost in a single, large-scale aggregation, allows for intermediate validation, and often aligns with natural data hierarchies. The effectiveness of this rewrite depends on the specific nature of the data and the aggregation task—the LLM agent must consider the appropriate granularity and design effective prompts for both aggregation steps.

 
 
 
### 
 3.2. LLM-Centric Improvements

 
 This category addresses unique behaviors of LLMs that can be leveraged for optimization. We present two categories of rewrite directive: gleaning and duplicate resolution .

 
#### 
 3.2.1. Gleaning (Map and Reduce)

 
 Figure 4. Gleaning process with k = 1 𝑘 1 k=1 round of refinement. An LLM initially extracts information from an input transcript, and Officer Y is missing from the output. A validation agent (powered by an LLM) then identifies this omission and provides feedback. The original LLM incorporates this feedback in a second pass (shown with purple arrows), resulting in a more complete final output that includes both Officer X and Officer Y. 
 
 
 For this directive, we rely on the insight that when prompted with the previous inputs and outputs, and asked to improve the outputs, an LLM can iteratively refine the output.
While iterative refinement has been implemented for specific tasks like knowledge graph entity extraction  (Edge et al . , 2024 ) , we generalize this concept into a rewrite directive applicable to both map and reduce operations. Our approach, which we call gleaning , employs separate validator and data generation LLMs to iteratively improve output quality.
We formalize the gleaning process for map operations as:

 

 
 (7) 
 
 Map ⇒ Map → ( Map v → Map i ) ≤ k ⇒ Map Map → superscript → subscript Map 𝑣 subscript Map 𝑖 absent 𝑘 \text{Map}\Rightarrow\text{Map}\to(\text{Map}_{v}\to\text{Map}_{i})^{\leq k} 
 
 
 
 Here, k 𝑘 k represents the maximum number of refinement iterations, Map v subscript Map 𝑣 \text{Map}_{v} is a validation operation, and Map i subscript Map 𝑖 \text{Map}_{i} is a refinement operation. The process works as follows:

 
 
 
 (1) 
 
 Initial Operation: The data processing LLM performs the original map operation on the input data.

 
 (2) 
 
 Evaluation Step: A separate validator LLM ( Map v subscript Map 𝑣 \text{Map}_{v} ) evaluates the output. It receives the original prompt, the data processor’s response, and a task-specific validation prompt. The validator determines if refinement is needed and provides specific feedback on how to improve the output, if so.

 
 (3) 
 
 Refinement Step: If refinement is needed, the original data processing LLM ( Map i subscript Map 𝑖 \text{Map}_{i} ) refines its previous output based on the validator’s feedback. Importantly, this LLM retains the chat history, including the original prompt, its previous response, and the validator’s feedback, allowing it to refine rather than regenerate from scratch.

 
 (4) 
 
 Iteration: Steps 2 and 3 are repeated up to k 𝑘 k times, or until no further refinement is needed.

 
 This approach ensures that the validator has full context while assessing the output, and that refinement builds upon previous work rather than starting anew. If no refinement is needed, the output passes directly to the next operation in the pipeline.

 
 A similar approach can be applied to reduce operations:

 

 
 (8) 
 
 Reduce ⇒ Reduce → ( Map v → Reduce i ) ≤ k ⇒ Reduce Reduce → superscript → subscript Map 𝑣 subscript Reduce 𝑖 absent 𝑘 \text{Reduce}\Rightarrow\text{Reduce}\to(\text{Map}_{v}\to\text{Reduce}_{i})^{\leq k} 
 
 
 
 For reduce operations, the refinement is applied at the level of a group, not to individual documents. This allows for improvements in the quality of aggregations, taking into account the collective context of the grouped data.

 
 
#### 
 3.2.2. Duplicate Key Resolution (Reduce)

 
 A big challenge in LLM-powered data processing is that grouping, aggregation, and summarization is difficult due to the
fact that LLM outputs are not canonicalized, and may contain many
semantic duplicates.
To address semantic duplicates in reduce keys, especially those derived from LLM-powered operations, we introduce resolve operations:

 

 
 (9) 
 
 Reduce K , x ⇒ ( Resolve k 1 ​ ‖ … ‖ ​ Resolve k m ) → Reduce K , x ⇒ subscript Reduce 𝐾 𝑥 subscript Resolve subscript 𝑘 1 norm … subscript Resolve subscript 𝑘 𝑚 → subscript Reduce 𝐾 𝑥 \text{Reduce}_{K,x}\Rightarrow(\text{Resolve}_{k_{1}}\parallel\ldots\parallel\text{Resolve}_{k_{m}})\to\text{Reduce}_{K,x} 
 
 
 
 Where { k 1 , … , k m } ⊆ K subscript 𝑘 1 … subscript 𝑘 𝑚 𝐾 \{k_{1},\ldots,k_{m}\}\subseteq K are each a disjoint subset of keys to be resolved. Each Resolve k i subscript Resolve subscript 𝑘 𝑖 \text{Resolve}_{k_{i}} operation consolidates semantically equivalent values for the key k i subscript 𝑘 𝑖 k_{i} . This directive helps ensure that semantically similar keys are properly grouped together during the reduce operation. The motivation for this rewrite directive stems from the inherent variability in LLM outputs: when LLMs are used to generate keys for reduce operations, they may produce semantically equivalent but syntactically different values. For example, “New York City,” “NYC,” and “The Big Apple” might all refer to the same entity. Without resolution, these would be treated as separate keys, leading to fragmented and potentially inaccurate aggregations.

 
 
 
### 
 3.3. Projection Synthesis

 
 Projection synthesis strategies are inspired by traditional projection pushdown optimizations in database systems. While selections (and selection pushdown) can also be synthesized, we did not implement this, as we found that agents are not very effective at determining whether certain data could be relevant to the query (they are overly biased by prompt wording and tend to be overly inclusive). Moreover, since an LLM-based selection is just as costly as a map operation, as both require an LLM call for every document, we focused on map operations that transform the data by shrinking its size through a form of projection.

 
 With LLM agents, we can dynamically synthesize projections to “push down” based on the specific task and data at hand. However, programming LLM agents to synthesize these effectively is not straightforward, as there are potentially infinite projections that could be synthesized without necessarily improving pipeline accuracy or output quality. We present several instances of projection synthesis directives along with triggers and criteria for LLM agents to implement them effectively.

 

 
 (10) 
 
 Map x subscript Map 𝑥 \displaystyle\text{Map}_{x} 
 ⇒ Map x 1 → Map x 2 → ⋯ → Map x n ⇒ absent subscript Map subscript 𝑥 1 → subscript Map subscript 𝑥 2 → ⋯ → subscript Map subscript 𝑥 𝑛 \displaystyle\Rightarrow\text{Map}_{x_{1}}\to\text{Map}_{x_{2}}\to\cdots\to\text{Map}_{x_{n}} 
 
 
 
 (11) 
 
 Map y subscript Map 𝑦 \displaystyle\text{Map}_{y} 
 ⇒ ( Map y 1 ​ ‖ Map y 2 ‖ ​ ⋯ ∥ Map y m ) → Reduce ⇒ absent conditional subscript Map subscript 𝑦 1 norm subscript Map subscript 𝑦 2 ⋯ subscript Map subscript 𝑦 𝑚 → Reduce \displaystyle\Rightarrow(\text{Map}_{y_{1}}\parallel\text{Map}_{y_{2}}\parallel\cdots\parallel\text{Map}_{y_{m}})\to\text{Reduce} 
 
 
 
 (12) 
 
 Reduce K , x subscript Reduce 𝐾 𝑥 \displaystyle\text{Reduce}_{K,x} 
 ⇒ Map y → Reduce K , z ⇒ absent subscript Map 𝑦 → subscript Reduce 𝐾 𝑧 \displaystyle\Rightarrow\text{Map}_{y}\to\text{Reduce}_{K,z} 
 
 
 
 (13) 
 
 Equijoin x subscript Equijoin 𝑥 \displaystyle\text{Equijoin}_{x} 
 ⇒ ( Map y , L ∥ Map z , R ) → Equijoin w ⇒ absent conditional subscript Map 𝑦 𝐿 subscript Map 𝑧 𝑅 → subscript Equijoin 𝑤 \displaystyle\Rightarrow(\text{Map}_{y,L}\parallel\text{Map}_{z,R})\to\text{Equijoin}_{w} 
 
 
 

 
 
 
 • 
 
 Chaining ( 10 ): This directive synthesizes a chain of simpler projections for complex map operations. This is useful when a map prompt contains multiple instructions or describes a complex task without detailing its steps. Each Map x i subscript Map subscript 𝑥 𝑖 \text{Map}_{x_{i}} builds upon the results of the previous projection. For example, a map operation to analyze a legal document could be chained into: extract entities, summarize key points, and generate recommendations.

 
 • 
 
 Isolating ( 11 ): For map operations involving multiple independent subtasks, this directive synthesizes separate projections to reduce the scope of work for each projection. This allows for parallel execution of independent projections, followed by a reduce step to combine the results. For instance, analyzing customer feedback could involve parallel projections to classify sentiment, identify product features mentioned, and flag urgent issues.

 
 • 
 
 Pre-Aggregation ( 12 ): When input data for a reduce operation is too complex or verbose, we could create a projection to extract only the data relevant to the aggregation. This can improve both efficiency and quality of the final aggregation. For example, when summarizing shipping-related feedback by product category, we might first “project” each review to a concise summary of shipping-related comments before aggregating.

 
 • 
 
 Pre-Joining ( 13 ): For complex equijoin operations, we could create projections to preprocess documents from both datasets before joining. This is effective when direct comparison of original documents might be computationally expensive or error-prone. For instance, when matching research papers with funding opportunities, we could project papers to their key themes and methodologies, and funding descriptions to their main criteria, before performing the join.

 
 Implementing these directive requires taking into account the task and data characteristics. For instance, chaining is most effective when there’s a clear sequence of subtasks, while isolating works best for truly independent subtasks. Pre-aggregation and pre-joining are useful when dealing with verbose documents where focused extraction can significantly simplify downstream operations.

 
 One may wonder why there exists a directive for each operator (e.g., map before reduce, map before equijoin). This is because the criteria for determining whether an LLM can successfully implement the directive differs based on the operator. For example, in the case of pre-joining, the LLM agent needs to consider factors such as the sufficiency of current keys, the presence of overly long attributes, the possibility of combining information across attributes, and potential mismatches in information representation between datasets. If a transformation is deemed beneficial, the agent then generates an LLM prompt to create a new key-value pair that extracts a smaller, more relevant representation of the data for the join task. Similarly, for other operators, the LLM agent would consider operator-specific factors to determine the applicability and potential benefit of the directive. This approach ensures that synthesized projections are tailored to the specific requirements of the task, the characteristics of the data, and the nature of the operator, rather than applying a one-size-fits-all approach.

 
 
 
## 
 4. Optimizer

 
 Here, we detail DocETL ’s query planning and optimization process. Users declare their pipeline at a high level in a file pipeline.yaml , and run docetl build pipeline.yaml ,
to get a new YAML file that describes an optimized pipeline for the same data.
 DocETL ’s optimization process employs two types of agents: Generation agents apply the logical rewrite rules to create a diverse set of candidate plans, as shown by the “Apply Rewrites (Agent)” boxes in  Figure   1 .
And validation agents generate custom prompts to assess the quality of the outputs produced by candidate plans.
Per operation or sub-pipeline, the validation agents evaluate all candidate sub-plans on a data sample to select the optimal sub-plan, as represented by the green (selected) and gray (evaluated but not selected) sub-plans in  Figure   1 ;
we will describe both steps in more detail next.
At a high level, our optimization framework is reminiscent of recursive top-down optimization frameworks like Cascades, but we apply
a different criterion to “expand” into a rule (directive in our case),
as well as a different approach to determine the best sub-plan.
Unlike traditional query optimizers that rely on cost models,
we use LLM-based validation to determine when to expand a directive and how to evaluate sub-plans.

 
 
 
 Input: Pipeline P 𝑃 P (sequence of operators), Sample data D 𝐷 D 

 
 
 Output: Optimized pipeline P o ​ p ​ t subscript 𝑃 𝑜 𝑝 𝑡 P_{opt} 

 
 1 

 

 
 2 
 Function   OptimizePipeline( P , D 𝑃 𝐷 P,D ) : 

 
 3          
 o ​ p ​ t ​ i ​ m ​ i ​ z ​ e ​ d ← [ ] ← 𝑜 𝑝 𝑡 𝑖 𝑚 𝑖 𝑧 𝑒 𝑑 optimized\leftarrow[] ; 

 
 4          
 foreach   operation o ​ p ∈ P 𝑜 𝑝 𝑃 op\in P   do 

 
 5                  
 if   o ​ p . n ​ e ​ e ​ d ​ s ​ C ​ o ​ n ​ f ​ i ​ g formulae-sequence 𝑜 𝑝 𝑛 𝑒 𝑒 𝑑 𝑠 𝐶 𝑜 𝑛 𝑓 𝑖 𝑔 op.needsConfig   then 

 
                          
 // Synthesize config for new ops created by rewrite rules, including prompts, output schemas, and operator-specific parameters (e.g., reduce_key for reduce) 

 
 6                          
 o ​ p . c ​ o ​ n ​ f ​ i ​ g ← formulae-sequence 𝑜 𝑝 ← 𝑐 𝑜 𝑛 𝑓 𝑖 𝑔 absent op.config\leftarrow GenerationAgent.SynthesizeConfig( o ​ p 𝑜 𝑝 op ); 

 
 7                          
 

 
 8                  
 if   ( [ ([ suffix of o p t i m i z e d ] → o p ) optimized]\to op) matches a rewrite rule   then 

 
 9                          
 s u b p l a n ← [ subplan\leftarrow[ matching suffix of o p t i m i z e d ] → o p optimized]\to op ; 

 
 10                          
 o ​ p ​ t ​ i ​ m ​ i ​ z ​ e ​ d ​ _ ​ s ​ u ​ b ← ← 𝑜 𝑝 𝑡 𝑖 𝑚 𝑖 𝑧 𝑒 𝑑 _ 𝑠 𝑢 𝑏 absent optimized\_sub\leftarrow OptimizeSubPipeline( s ​ u ​ b ​ p ​ l ​ a ​ n , D 𝑠 𝑢 𝑏 𝑝 𝑙 𝑎 𝑛 𝐷 subplan,D ); 

 
 11                          
Replace matching suffix of o ​ p ​ t ​ i ​ m ​ i ​ z ​ e ​ d 𝑜 𝑝 𝑡 𝑖 𝑚 𝑖 𝑧 𝑒 𝑑 optimized with o ​ p ​ t ​ i ​ m ​ i ​ z ​ e ​ d ​ _ ​ s ​ u ​ b 𝑜 𝑝 𝑡 𝑖 𝑚 𝑖 𝑧 𝑒 𝑑 _ 𝑠 𝑢 𝑏 optimized\_sub ; 

 
 12                          
 

 
 13                  
 else 

 
 14                          
 o ​ p ​ t ​ i ​ m ​ i ​ z ​ e ​ d ​ _ ​ s ​ u ​ b ← ← 𝑜 𝑝 𝑡 𝑖 𝑚 𝑖 𝑧 𝑒 𝑑 _ 𝑠 𝑢 𝑏 absent optimized\_sub\leftarrow OptimizeSubPipeline( [ o ​ p ] , D delimited-[] 𝑜 𝑝 𝐷 [op],D ); 

 
 15                          
Append o ​ p ​ t ​ i ​ m ​ i ​ z ​ e ​ d ​ _ ​ s ​ u ​ b 𝑜 𝑝 𝑡 𝑖 𝑚 𝑖 𝑧 𝑒 𝑑 _ 𝑠 𝑢 𝑏 optimized\_sub to o ​ p ​ t ​ i ​ m ​ i ​ z ​ e ​ d 𝑜 𝑝 𝑡 𝑖 𝑚 𝑖 𝑧 𝑒 𝑑 optimized ; 

 
 16                          
 

 
 17                  end if 

 
 18                  

 
 19          end foreach 

 
 20          return o ​ p ​ t ​ i ​ m ​ i ​ z ​ e ​ d 𝑜 𝑝 𝑡 𝑖 𝑚 𝑖 𝑧 𝑒 𝑑 optimized ; 

 
 21          
 

 
 22 

 
 23 

 
 
 

 Algorithm 1 Pipeline Optimization 
 
 
 
 
 1 

 
 Input: Sub-pipeline S ​ P 𝑆 𝑃 SP , Sample data D 𝐷 D 

 
 
 Output: Optimized sub-pipeline S ​ P o ​ p ​ t 𝑆 subscript 𝑃 𝑜 𝑝 𝑡 SP_{opt} 

 
 2 

 

 
 3 
 Function   OptimizeSubPipeline( S ​ P , D 𝑆 𝑃 𝐷 SP,D ) : 

 
 4          
 if   S ​ P 𝑆 𝑃 SP does not match any rewrite rule   then 

 
 5                  
 return S ​ P 𝑆 𝑃 SP ; 

 
 6                  
 

 
 7          
Execute S ​ P 𝑆 𝑃 SP on D 𝐷 D to get outputs; 

 
          
 // Synthesize a prompt for validating sub-pipeline output 

 
 8          
 V ← ← 𝑉 absent V\leftarrow ValidationAgent.SynthesizeValidatorPrompt( D 𝐷 D , outputs, S ​ P 𝑆 𝑃 SP ); 

 
 9          
 if   ValidationAgent.Validate(outputs, V 𝑉 V ) is satisfactory   then 

 
 10                  
 return S ​ P 𝑆 𝑃 SP ; 

 
 11                  
 

 
 12          
 c ​ a ​ n ​ d ​ i ​ d ​ a ​ t ​ e ​ _ ​ p ​ l ​ a ​ n ​ s ← [ ] ← 𝑐 𝑎 𝑛 𝑑 𝑖 𝑑 𝑎 𝑡 𝑒 _ 𝑝 𝑙 𝑎 𝑛 𝑠 candidate\_plans\leftarrow[] ; 

 
 13          
 foreach   rule R ∈ 𝑅 absent R\in applicable rewrite rules for S ​ P 𝑆 𝑃 SP   do 

 
                  
 // R applied to SP generates a mix of old and new ops 

 
 14                  
 r ​ e ​ w ​ r ​ i ​ t ​ t ​ e ​ n ​ _ ​ o ​ p ​ s ← ← 𝑟 𝑒 𝑤 𝑟 𝑖 𝑡 𝑡 𝑒 𝑛 _ 𝑜 𝑝 𝑠 absent rewritten\_ops\leftarrow R 𝑅 R applied to S ​ P 𝑆 𝑃 SP ; 

 
 15                  
 p ​ l ​ a ​ n ← ← 𝑝 𝑙 𝑎 𝑛 absent plan\leftarrow OptimizePipeline( r ​ e ​ w ​ r ​ i ​ t ​ t ​ e ​ n ​ _ ​ o ​ p ​ s , D 𝑟 𝑒 𝑤 𝑟 𝑖 𝑡 𝑡 𝑒 𝑛 _ 𝑜 𝑝 𝑠 𝐷 rewritten\_ops,D ) ; 

 
 16                  
Append p ​ l ​ a ​ n 𝑝 𝑙 𝑎 𝑛 plan to c ​ a ​ n ​ d ​ i ​ d ​ a ​ t ​ e ​ _ ​ p ​ l ​ a ​ n ​ s 𝑐 𝑎 𝑛 𝑑 𝑖 𝑑 𝑎 𝑡 𝑒 _ 𝑝 𝑙 𝑎 𝑛 𝑠 candidate\_plans ; 

 
 17                  
 

 
 18          end foreach 

 
 19          S ​ P o ​ p ​ t ← PlanSelection ​ ( c ​ a ​ n ​ d ​ i ​ d ​ a ​ t ​ e ​ _ ​ p ​ l ​ a ​ n ​ s , V , D , k ) ← 𝑆 subscript 𝑃 𝑜 𝑝 𝑡 PlanSelection 𝑐 𝑎 𝑛 𝑑 𝑖 𝑑 𝑎 𝑡 𝑒 _ 𝑝 𝑙 𝑎 𝑛 𝑠 𝑉 𝐷 𝑘 SP_{opt}\leftarrow\text{PlanSelection}(candidate\_plans,V,D,k) ; 

 
 20          
 return S ​ P o ​ p ​ t 𝑆 subscript 𝑃 𝑜 𝑝 𝑡 SP_{opt} ; 

 
 21          
 

 
 22 

 
 23 

 
 
 

 Algorithm 2 Sub-pipeline Optimization 
 
 
 
 
 Input: Candidate plans C 𝐶 C , Validation prompt V 𝑉 V , Sample data D 𝐷 D , Number of top plans to compare k 𝑘 k 

 
 
 Output: Best plan b ​ e ​ s ​ t ​ _ ​ p ​ l ​ a ​ n 𝑏 𝑒 𝑠 𝑡 _ 𝑝 𝑙 𝑎 𝑛 best\_plan 

 
 1 
 foreach   plan p ∈ C 𝑝 𝐶 p\in C   do 

 
 2          
Execute p 𝑝 p on each sample in D 𝐷 D ; 

 
 3          
Use ValidationAgent to rate outputs on a scale of 1 (very bad) to 4 (no identified improvements) according to V 𝑉 V ; 

 
 4          
Compute average score for p 𝑝 p ; 

 
 5          
 

 
 6 end foreach 

 
 7 Select top k 𝑘 k plans based on average scores; 

 
 8 
 foreach   pair of plans ( p i , p j ) subscript 𝑝 𝑖 subscript 𝑝 𝑗 (p_{i},p_{j}) in top k 𝑘 k plans   do 

 
 9          
Perform pairwise comparison using ValidationAgent and V 𝑉 V ; 

 
 10          
Update comparison scores for p i subscript 𝑝 𝑖 p_{i} and p j subscript 𝑝 𝑗 p_{j} ; 

 
 11          
 

 
 12 end foreach 

 
 13 b ​ e ​ s ​ t ​ _ ​ p ​ l ​ a ​ n ← ← 𝑏 𝑒 𝑠 𝑡 _ 𝑝 𝑙 𝑎 𝑛 absent best\_plan\leftarrow plan with highest comparison score; 

 
 
 return b ​ e ​ s ​ t ​ _ ​ p ​ l ​ a ​ n 𝑏 𝑒 𝑠 𝑡 _ 𝑝 𝑙 𝑎 𝑛 best\_plan 

 

 Algorithm 3 Plan Selection 
 
 
### 
 4.1. Optimization Approach

 
 DocETL ’s plan building process employs a top-down optimization approach that considers both individual operations and sub-pipelines, as outlined in Algorithm  1 and visualized in  Figure   1 . The process can be summarized as follows:

 
 
 
 (1) 
 
 Pipeline Traversal and Sub-pipeline Identification : We iterate through the pipeline from input to output (left to right). For each operation, we consider whether it, along with a suffix of the already-optimized operations, forms a sub-pipeline that matches any rewrite rule. If no matching sub-pipeline is found, we treat the current operation as a single-operation sub-pipeline to optimize. For each identified sub-pipeline:

 
 
 • 
 
 We use the validation agent to synthesize a custom validation prompt tailored to the specific task described by the sub-pipeline.

 
 • 
 
 The validation agent examines a sample of outputs using this prompt to determine if there’s room for improvement. If the agent concludes that the current implementation is satisfactory, we move on to the next operation without further optimization, as shown by the no-change (“NC”) paths in  Figure   1 .

 
 This process is outlined in Algorithm  1 , and the initial validation step is shown in Algorithm  2 (lines 5-7).

 
 (2) 
 
 Rewrite Rule Application and Recursive Optimization : When optimization is needed, we apply matching rewrite rules to the sub-pipeline or individual operation. As illustrated in  Figure   1 , we explore various rewrite rules from Section   3 . For each applicable rule, an LLM agent synthesizes new operations and configurations (e.g., prompts, output schemas) to match the rule. When new operations are created as part of a rewrite, we immediately optimize them recursively before continuing with the current optimization, as shown by the nested “Apply Rewrites” rectangles in the figure. This opportunistic approach allows us to explore more refined plans efficiently (Algorithm  2 , lines 10-11).

 
 (3) 
 
 Plan Evaluation and Selection : Multiple candidate plans can arise from the rewrite directives, as depicted by the various branches in Figure  1 . We employ a two-stage evaluation process to select the best plan: First, we execute each plan on a sample of data and use the validation agent to rate the output for each document, computing an average rating per plan. We then select the top k 𝑘 k rated plans (currently set to 6) for further comparison. Next, the agent performs pairwise comparisons between these top plans, evaluating their outputs against each other. The plan with the most “wins” in these comparisons is selected as the optimal plan for the current sub-pipeline or operation, represented by the green boxes in  Figure   1 . This hybrid approach balances efficiency and accuracy in plan evaluation, as pairwise comparisons are known to be ideal for assessing relative quality  (Parameswaran et al . , 2023 ; Liu et al . , 2024c ) , but with potentially 100+ candidate plans generated by various rewrite rules (each rewrite can have multiple candidate plans, e.g., different parallel projections synthesized), comparing all pairs becomes computationally infeasible.

 
 (4) 
 
 Pipeline Update : We integrate the selected optimized plan into the overall pipeline, replacing the original operation or sub-pipeline (Algorithm  1 , lines 9-12).

 

 
 An important question is how we sample the data to execute candidate plans with. We begin with an initial sample of the input data, where the probability of selecting each document is proportional to its size, ensuring longer documents have a higher chance of being included in the sample. As we optimize each sub-pipeline, we calculate its selectivity—the ratio of the number of output documents to input documents. For instance, a filter operation might have a selectivity of 0.5 if it outputs half as many documents as it receives. Then, when optimizing a later sub-pipeline, we use the stored selectivities of all preceding operations to estimate how many input records we need to produce a sufficient number of records for the current optimization task. We rerun the partially optimized pipeline up to the current sub-pipeline using this adjusted input sample size. This approach ensures that even after several selective operations, we still have enough data to optimize effectively: For example, if we are optimizing the third operation in a pipeline, and the first two operations have selectivities of 0.5 and 0.3 respectively, we might increase our initial sample size by a factor of ( 1 / 0.5 / 0.3 ) ≈ 6.67 1 0.5 0.3 6.67 (1/0.5/0.3)\approx 6.67 to ensure we have enough data for the third operation. It’s important to note that samples used during the building process may not always be representative of the full dataset. For instance, if sample documents don’t exceed LLM context limits, we may encounter issues when running the optimized plan on the complete dataset. We are developing mechanisms to identify such discrepancies and alert users, potentially offering solutions like on-the-fly updates to plans to include chunking.

 
 Our overall approach lends itself to a rich space of pipeline optimization techniques with operator reordering operator fusion. While we have not implemented any in the current release of DocETL , we are actively exploring this area for future improvements.

 
 
### 
 4.2. Agent Architecture

 
 Here, we outline our novel agent-based architecture for generation and validation. While a comprehensive analysis of our architectures is beyond the scope of this paper, we focus on critical aspects that significantly impact system performance and effectiveness.

 
#### 
 4.2.1. Generation Agents

 
 Generation agents are responsible for applying rewrite directives to create diverse candidate plans. When presented with a directive, these agents synthesize one or more appropriate operation configurations. These configurations encompass both logical and physical choices. Logical choices include prompts, output schemas, and reduce keys, while physical choices involve parameters such as chunk sizes for document splitting and batch sizes for document reduction. The generation agent also evaluates the applicability of rewrite rules in specific contexts. For instance, the agent might determine that applying the split-map rule ( Equation   2 ) is not beneficial if there’s no valuable document-level metadata to leverage when processing individual chunks.

 
 For certain parameter choices, particularly those related to physical implementation, LLMs may not be well-suited to determine optimal values. For example, how would an LLM know the ideal number of documents to summarize together in a batch as part of a reduce operation? In these cases, we employ a combination of heuristics and empirical evaluation. We use heuristics to generate a range of plausible parameter values, such as different batch sizes for a reduce operation. For each parameter value, we create and execute a corresponding plan on a sample of input data. We then compare the results of these plans to determine the most effective parameter choice for the given operation and context.
Here, we detail three examples of our generation agent’s approach for parameter selection:

 
 Chunk Sizes. Our chunking approach explores sizes ranging from 20% to 80% of the LLM’s context limit. For each chunk size, we generate a set of gather configurations to retain relevant context from surrounding chunks. The creation of these gather configurations is based on the ratio of chunk size to document size.

 
 We begin with three base configurations of gather operations for each chunk size: no context, one previous chunk, and one previous plus one next chunk. We then expand this set based on the document-to-chunk size ratio. For larger ratios (indicating smaller chunks relative to the document size), we generate configurations with more peripheral context. We use a square root function to control the growth of peripheral context as the document-to-chunk ratio increases, preventing excessive context that could overwhelm the model. The choice of square root is based on empirical observations that the benefit of additional context tends to diminish more drastically as more context is added—a detailed evaluation is left for future work. For example, if the document is significantly larger than the chunk size, our expanded set might include configurations with up to 5 previous chunks and 2 next chunks. Conversely, for ratios closer to 1 (where chunk size approaches document size), our set comprises only the base configurations.

 
 This basic approach is a first attempt at systematically exploring various chunking and gathering strategies. We are currently developing a taxonomy of LLM-powered data processing tasks to further refine this process. Our goal is to eventually use task classification to guide the generation of more tailored chunk sizes and gather configurations, recognizing that optimal settings may vary significantly depending on the specific task at hand.

 
 Batch Sizes. For reduce operations, optimal batch sizes (i.e., the number of documents aggregated at once, in a single prompt) are not obvious and require experimentation. Our agent tests sizes from 20% to 100% of the maximum input fitting the LLM’s context window, generating and evaluating multiple fold prompts for each. Our evaluations reveal task-dependent optimal batch sizes, highlighting the need for further research in this area—some tasks perform best with the smallest batch size (e.g., extracting distinct names), while others peak at a middle batch size, as shown in Section   5 .

 
 Blocking Keys and Rules. Resolve and equijoin operators involve pairwise comparisons between entities or records, leading to quadratic complexity in LLM calls. To mitigate this, a common technique is to use blocking to filter the number of pairs  (Christophides et al . , 2020 ) . DocETL offers two blocking approaches: embedding-based and code-based. Embedding-based blocking leverages an embedding model (default: OpenAI’s text-embedding-3-small) to generate vector representations for each document or subset of key-value pairs in a document (i.e., blocking keys ). We compute cosine similarities between these embeddings and only consider pairs whose similarity exceeds a specified threshold for full LLM-based comparison. Code-based blocking allows custom Python expressions to be specified as filters. While blocking keys and code-based blocking rules can be directly constructed by the generation agents, we employ a different approach for determining the embedding threshold. Instead of asking an LLM to arbitrarily come up with a similarity threshold, we empirically determine it: first, we sample hundreds of pairs that are likely to be duplicates based on their embedding similarity. We then execute the comparison prompt on these pairs to identify the true duplicates. Finally, we select the threshold that achieves 95% recall in duplicate identification.

 
 
#### 
 4.2.2. Validation Agents

 
 Validation agents are tasked with assessing the effectiveness of optimized sub-pipelines. These agents synthesize task-specific validation prompts for any sub-pipeline under optimization. Using these custom prompts, validation agents also determine whether a given sub-pipeline meets the criteria defined in the validation prompt (e.g., there are no potential improvements, for example, in precision and recall), or if further optimization is necessary. Finally, to pick the best candidate plan for a rewrite, validation agents employ a two-stage approach for plan comparison. First, they rate each plan’s output on a scale from 1 (very bad) to 5 (excellent) based on the synthesized validation criteria. Then, they perform pairwise comparisons between the top- k 𝑘 k rated plans, providing a more nuanced evaluation of relative performance, as described in Algorithm 3 . While we set k = 6 𝑘 6 k=6 in our system, we leave a more robust parameter selection strategy for future work.

 
 
#### 
 4.2.3. Implementation Details

 
 DocETL leverages GPT-4o (OpenAI) as the primary LLM for both generation and validation agents. To optimize performance and resource utilization, we cache all sub-pipeline outputs. This memoization approach serves two purposes: it eliminates redundant computations during later evaluation stages, such as pairwise comparisons following initial ratings, and enables efficient execution of pipelines that build upon previously optimized sub-pipelines—which is important for optimizing operations in the latter stages of the pipeline.

 
 Both generation and validation agents consider a variety of inputs in their prompts, including user-defined operation prompts, sample operation input data, and, when relevant (i.e., for evaluation), sample operation output data. Often, including all of this data in a single prompt exceeds the LLM’s context limits. When this happens, we have to remove information from the prompt. We prioritize keeping the following types of information:

 
 
 
 (1) 
 
 Output Schema Attributes : These are given the highest priority, with all tokens included—which is feasible because LLM output limits are typically much smaller than prompt (i.e., input) limits.

 
 (2) 
 
 Prompt-Referenced Attributes : Of next priority is input attributes explicitly referenced in the prompt template, ensuring the LLM has access to all task-critical information.

 
 (3) 
 
 Remaining Input Attributes : For any additional attributes in the input document(s), we implement a middle truncation strategy. This method preserves both the initial and final portions of the content, which often encapsulate key information, while judiciously truncating the middle sections as necessary.

 

 
 
 
 
## 
 5. Experimental Evaluation

 
 In this section, we showcase DocETL ’s performance on three real-world, complex tasks involving police misconduct identification, polarizing feature analysis across video game reviews, and declassified document analysis. For each task, the dataset is unstructured, and documents may exceed LLM context window limits. We did not implement baselines in existing systems for these case studies  (Patel et al . , 2024 ; Liu et al . , 2024b ; Anderson et al . , 2024 ) , as they do not support complex data processing; in particular, they do not support a resolve operator nor handle long documents that exceed context lengths, both of which are crucial for these tasks. However, in Section   5.4 , we apply DocETL to tasks posed by Patel et al . ( 2024 ) and Liu et al . ( 2024b ) .

 
 Across the three studies in Sections   5.1 , 5.2 and  5.3 , we evaluate DocETL ’s ability to handle varying document lengths, from short articles to extensive reports exceeding LLM context limits. We test its performance on tasks requiring different levels of reasoning complexity, ranging from extracting specific information (e.g., names of police officers) to identifying frequently-occurring themes with contradicting opinions. For the police misconduct identification ( Section   5.1 ) and declassified document analysis ( Section   5.3 ) tasks, we employ human evaluation to validate the quality and comprehensiveness of DocETL ’s outputs. We compare the pipeline selected by DocETL ’s optimizer against competitive alternatives, including those crafted by domain experts or other pipelines considered by DocETL during optimization. Our goal is to demonstrate that DocETL can effectively optimize pipelines for diverse, real-world tasks, significantly outperforming manually crafted solutions.

 
### 
 5.1. Police Misconduct Identification

 
 We conducted an experiment on police misconduct identification ( Example   1.1 ) using a dataset of 227 documents from various California police departments. This is only a sample of the hundreds of thousands of documents collected by our collaborators at the California Police Records Access Project 4 4 4 https://cdss.berkeley.edu/news/state-funds-development-first-its-kind-police-misconduct-database . This dataset presented several challenges: documents averaged 12,500 tokens, with 2% exceeding the 128,000 token context window limit. The corpus covered multiple types of documents, including court documents, police reports, and internal investigation reports, with an unknown number of cases and several hundred police officers mentioned 5 5 5 Due to the presence of PII, and the sensitive nature of these documents, we unfortunately cannot open-source our data or prompts. .

 
 The task was to generate detailed misconduct summaries for each officer who exhibited misconduct, including the officer’s name, misconduct types, and a comprehensive summary. We implemented an initial pipeline in DocETL consisting of a map operation to extract officers who exhibited misconduct from each document, followed by an unnest operation to flatten this list of officers, and a reduce operation to summarize misconduct across relevant documents for each officer. For documents exceeding the context limit, we truncated tokens from the middle until they fit within the LLM’s context window. Prompts for this pipeline define “misconduct” and are written by engineers and journalists employed full-time by the Police Records Access Project.

 
 Running this pipeline as-is lead to very incorrect outputs, as police officer names need to undergo entity resolution prior to the reduce operation. In practice, the team runs a domain-specific clustering algorithm, followed by human annotation, to de-duplicate police officer names. As such, our initial pipeline (denoted Baseline ) therefore also includes a resolve operation before the reduce operation, as per the rewrite directive, Equation   9 . This resolve operation was synthesized by DocETL (i.e., comparison prompt, resolution prompt, and embedding thresholds for blocking).

 
 We evaluated two other pipeline variants, each of which were considered by the optimizer, as well as the final one chosen by the optimizer, all using GPT-4o-mini. It is not obvious which pipeline will be most accurate. The pipelines are as follows:

 
 
 (1) 
 
 DocETL S subscript DocETL 𝑆 \textsc{DocETL}_{S} : This pipeline applies Equation   12 —a projection synthesis rewrite—to extract misconduct summaries for identified officers in addition to the officer name before the resolve step. The reduce operation then only summarizes these extracted summaries, as opposed to processing the entire documents.

 
 (2) 
 
 DocETL T subscript DocETL 𝑇 \textsc{DocETL}_{T} : This pipeline builds upon DocETL S subscript DocETL 𝑆 \textsc{DocETL}_{S} by extracting both misconduct summaries and types from each document. It then incorporates both the summaries and types in the reduce step, providing more structured information for aggregation.

 
 (3) 
 
 DocETL O subscript DocETL 𝑂 \textsc{DocETL}_{O} : This pipeline, selected by the optimizer, extends DocETL T subscript DocETL 𝑇 \textsc{DocETL}_{T} by chunking documents into 12,840 token segments. It includes metadata extraction and a peripheral context configuration of two previous chunks in full and a summary of earlier content. The map operation is applied to each chunk, followed by a synthesized operation to reduce chunk results per document. Like other pipelines, this is then followed by the officer name resolution step and a final reduce step to aggregate summaries per officer. We will discuss the details of the plan subsequently.

 

 
 Results. To evaluate output quality without ground truth data, we came up with three binary criteria: (i) whether each officer name referred to a real person, (ii) if the summary included dates and locations of misconduct, and (iii) whether each identified misconduct instance was extensively described in the summary. To assess the accuracy of our evaluation criteria, we employed GPT-4o-mini as a judge to evaluate each criterion for over 1,500 outputs across the baseline and all variants. To validate the LLM’s judgments, we conducted a human evaluation on a subset of the data. For the first two criteria (officer name validity and inclusion of dates/locations), one of the authors manually assessed 100 randomly sampled outputs from both the baseline and DocETL variants. For the third criterion (extensive description of misconduct), due to the detailed and often graphic nature of the summaries, the author evaluated 50 output summaries, a process that required several hours of careful reading. The human evaluation revealed high agreement between the LLM judge and human assessor—96%, 97%, and 92% respectively—suggesting that our LLM-based evaluation method is a reliable proxy for human judgment in this task.

 
 Table   2 illustrates these results. DocETL O subscript DocETL 𝑂 \textsc{DocETL}_{O} is, on average, 1.34 × \mathbf{1.34\times} more accurate compared to the baseline. The DocETL S subscript DocETL 𝑆 \textsc{DocETL}_{S} and DocETL T subscript DocETL 𝑇 \textsc{DocETL}_{T} pipelines performed similarly, with the notable exception of DocETL S subscript DocETL 𝑆 \textsc{DocETL}_{S} , which often omitted dates and locations from summaries.

 
 Table 2. Evaluation Metrics for Police Misconduct Identification Pipelines. Each value represents the fraction of outputs that pass the metric. 
 
 
 
 
 
 Metric 
 
 
 
 
 Baseline 
 
 
 
 
 DocETL S subscript DocETL 𝑆 \textsc{DocETL}_{S} 
 
 
 
 
 DocETL T subscript DocETL 𝑇 \textsc{DocETL}_{T} 
 
 
 
 
 DocETL O subscript DocETL 𝑂 \textsc{DocETL}_{O} 
 
 
 
 
 
 
 
 
 The officer’s name is a specific name, not generic (e.g., not “Officer 1”) 
 
 
 
 
 0.84 
 
 
 
 
 0.93 
 
 
 
 
 0.89 
 
 
 
 
 0.87 
 
 
 
 
 
 
 The summary contains a date and location 
 
 
 
 
 0.67 
 
 
 
 
 0.1 
 
 
 
 
 0.91 
 
 
 
 
 0.92 
 
 
 
 
 
 
 Each identified instance of misconduct is described extensively in the summary 
 
 
 
 
 0.42 
 
 
 
 
 0.78 
 
 
 
 
 0.76 
 
 
 
 
 0.80 
 
 
 
 
 
 
 
 Our evaluation underscores the complexity and task-specific nature of assessing LLM-based pipelines. While the outputs of different plans may appear similar at first glance, our analysis reveals some variations in their quality and reliability. The baseline’s poor performance highlights the importance of our rewrite rules. DocETL S subscript DocETL 𝑆 \textsc{DocETL}_{S} ’s summaries consistently failed to mention locations. DocETL T subscript DocETL 𝑇 \textsc{DocETL}_{T} and DocETL O subscript DocETL 𝑂 \textsc{DocETL}_{O} offered the most reliable results, with the latter being particularly suited for longer documents. This variability in plan performance emphasizes the necessity of DocETL ’s custom validation agents, which demonstrated proficiency in understanding the task-specific nature of evaluation: for instance, the map operation’s evaluation prompt focused on the completeness of incident details and correct categorization of misconduct types, while the reduce operation’s prompt emphasized accuracy of aggregation and information retention across cases. Without such tailored validation mechanisms, discerning the relative strengths of each plan would be challenging, if not impossible—highlighting the critical role of task-specific optimization and evaluation in LLM-powered document analysis.

 
 DocETL’s Optimized Pipeline. The DocETL O subscript DocETL 𝑂 \textsc{DocETL}_{O} pipeline
can be expressed using our rewrite directive syntax as follows:

 

 
 
 
 Map → Unnest → Reduce ⇒ → Map Unnest → Reduce ⇒ absent \displaystyle\text{Map}\to\text{Unnest}\to\text{Reduce}\Rightarrow 
 
 
 
 
 
 Map M → Split → ( Map S ∥ Map H ) → Gather → Map → ( Map v → Map i ) ≤ 1 → Reduce D → Unnest → Resolve → Reduce → subscript Map 𝑀 Split → conditional subscript Map 𝑆 subscript Map 𝐻 → Gather → Map → absent → superscript → subscript Map 𝑣 subscript Map 𝑖 absent 1 subscript Reduce 𝐷 → Unnest → Resolve → Reduce \displaystyle\begin{aligned} \text{Map}_{M}\to\text{Split}\to(\text{Map}_{S}\parallel\text{Map}_{H})\to\text{Gather}\to\text{Map}\to\\
(\text{Map}_{v}\to\text{Map}_{i})^{\leq 1}\to\text{Reduce}_{D}\to\text{Unnest}\to\text{Resolve}\to\text{Reduce}\end{aligned} 
 
 
 
 where { officer_name } officer_name \{{\small\texttt{officer\_name}}\} is the reduce key for the final summarization.

 
 This pipeline begins with a map operation to extract metadata ( Map M subscript Map 𝑀 \text{Map}_{M} ), followed by document chunking of 12840 tokens each (Split). Each chunk then undergoes parallel processing: Map S subscript Map 𝑆 \text{Map}_{S} for summarization and Map H subscript Map 𝐻 \text{Map}_{H} for header extraction. The Gather operation collects context for each chunk, including the header lineage for the current chunk, 2 full previous chunks, and summaries of the other previous chunks. The original Map operation is then applied to each rendered chunk, with gleaning applied for refinement. Results from all chunks of a document are combined using Reduce D subscript Reduce 𝐷 \text{Reduce}_{D} . The pipeline then flattens the results (Unnest), resolves officer names (Resolve), and finally summarizes misconduct per officer (Reduce). This optimized pipeline incorporates several of our rewrite rules, including document chunking ( 1 ), header lineage context and summarization ( 3 ), gleaning for the Map operations ( 7 ), and duplicate key resolution ( 9 ).

 
 Costs. For our sample dataset of 227 documents, the baseline incurred $2.24, while DocETL S subscript DocETL 𝑆 \textsc{DocETL}_{S} and DocETL T subscript DocETL 𝑇 \textsc{DocETL}_{T} each cost $0.55. DocETL O subscript DocETL 𝑂 \textsc{DocETL}_{O} was more expensive at $1.35 due to processing all document chunks, but less expensive than the baseline. Running the optimizer incurred a cost of approximately $100 and took about 20 minutes, with the bulk of the expense attributed to validation agents processing lengthy documents. DocETL O subscript DocETL 𝑂 \textsc{DocETL}_{O} took 364.97 seconds to run, and all other pipelines completed in less than 180 seconds. While the optimization cost of $100 for a task that takes < $ 3 absent currency-dollar 3 <\$3 may seem high, note that we are merely operating on a sample of the overall dataset; processing the dataset has already cost the team over $50,000; so this one-time cost of $100 is amortized across processing hundreds of thousands of documents.
As part of this process, the optimizer considered and evaluated over 200 pipeline variants.
As models become more cost-effective (e.g., GPT-4o-mini is over 100 × 100\times cheaper), optimization costs will decrease significantly, making the investment even more worthwhile in the long run.

 
 
### 
 5.2. Polarizing Feature Analysis

 
 To evaluate DocETL ’s performance on complex multi-document reasoning tasks, we focused on identifying polarizing features across multiple video games. The specific task was to generate a report detailing five polarizing themes common across games, with each theme supported by quotes from different game reviews (at least three positive and three negative quotes per theme). This task requires synthesizing information from many reviews, reasoning about common patterns, and presenting a balanced perspective on each topic.

 
 We conducted this experiment using a subset of the STEAM review dataset, which contains 6 million reviews across tens of thousands of games (Sobkowicz and Stokowiec, 2016 ) . From this dataset, we selected 500 games with the most user feedback, sampling approximately 400 reviews for each game, balanced equally between positive and negative ratings. Each document in our dataset represents a different game, comprising concatenated review texts. On average, each document contains around 66,000 tokens, with some reaching up to 380,000 tokens. Approximately 12% of the games in our data set have review collections that exceed the context length limits of the OpenAI LLMs with the longest context.

 
 We implemented and compared three pipeline variants:

 
 
 (1) 
 
 Baseline : This pipeline concatenates all reviews into a single document, dropping tokens to fit within the GPT-4o context limit. Despite truncation, this approach still includes over 100 reviews (randomly sampled), providing sufficient data to identify patterns.

 
 (2) 
 
 DocETL O subscript DocETL 𝑂 \textsc{DocETL}_{O} : This map-reduce pipeline, selected by DocETL as the optimal approach, extracts polarizing themes and quotes for each game in the map phase, employing document chunking to handle reviews exceeding the context window. The map sub-pipeline utilizes a chunk-map-reduce structure as determined by DocETL ’s rewrite directive defined in Equation   1 (chunk size of ≈ 87 , 000 absent 87 000 \approx 87,000 tokens). The reduce step then aggregates these themes and quotes to identify common patterns across games, while also adding a round of gleaning, as defined in Equation   8 .

 
 (3) 
 
 DocETL H subscript DocETL 𝐻 \textsc{DocETL}_{H} : Following Equation   6 , this pipeline extends the previous one by introducing an additional reduce step. It first summarizes analyses from individual games, maintaining quotes for each identified theme, then performs a final reduction (also with one gleaning iteration) to synthesize results across all themes.

 

 
 The reduce operation in both DocETL O subscript DocETL 𝑂 \textsc{DocETL}_{O} and DocETL H subscript DocETL 𝐻 \textsc{DocETL}_{H} used the following prompt written by us:

 
 
 Analyze all the inputs and write a report of the 5 most common polarizing themes that appear across multiple games. Your report should include:
1. A name for each common theme
2. A brief summary of why it’s a common polarizing issue across games
3. Representative quotes from different games, both positive and negative. Mention the game name and the quote. There should be at least 1 positive and 1 negative quote for each theme for each game, and there should be at least 3 games represented for each theme. This should be comprehensive. 

 
 To further analyze the impacts of the gleaning optimization, for each pipeline, we applied 0, 1, 2, and 3 rounds of gleaning on the final reduce operation, resulting in a total of 12 distinct pipeline configurations. While our optimizer only considers gleaning-related plans with one iteration (to avoid excessive costs), we were interested in measuring whether gleaning beyond one iteration might improve the pipeline outputs, and how the impact of gleaning differed across the pipelines. Gleaning is particularly beneficial in this context due to the comprehensive nature of the required output report. For example, initially, the LLM might miss some important themes or fail to provide enough diverse quotes. Gleaning allows for iterative improvement, gradually expanding the coverage of themes and quotes. Reports also require a fair representation of both positive and negative quotes for each theme, and gleaning can help refine this balance. Moreover, as the LLM refines its output, it can better align the identified themes with the most prevalent and polarizing aspects across multiple games, rather than focusing on game-specific or superficial themes.

 
 Figure 5. Impact of gleaning iterations on polarizing theme analysis performance across three pipeline variants over 0-3 gleaning iterations. Red dashed lines indicate minimum values instructed by the prompt: 30 quotes (5 themes * 6 quotes per theme), and 15 games (5 themes * 3 games per theme minimum). The baseline pipeline with 0 gleaning iterations achieves scores of 0 because the output was “Processing entire content is infeasible due to its extensive length. Please provide a more manageable excerpt or specify the exact task.” —even though the prompt truncated reviews as to not exceed the context limit. 
 
 
 Results. For this task, our evaluation metrics are purely quantitative: the number of distinct quotes (target: ≥ 30 absent 30 \geq 30 ) and the number of distinct games referenced (target: ≥ 15 absent 15 \geq 15 ). On average, DocETL ’s chosen pipeline ( DocETL O subscript DocETL O \textsc{DocETL}_{O} ) identified 4.55 × \mathbf{4.55\times} more distinct quotes, and referenced 4.60 × \mathbf{4.60\times} more distinct games than the baseline. As shown in Figure   5 , we observed a significant increase in recall for all methods between 0 and 1 rounds of gleaning. Interestingly, while the numbers generally increased with additional gleaning rounds, we noted a slight decrease in some metrics by the third round, particularly for the number of themes identified (which aligns with our instruction to focus on five key themes). DocETL O subscript DocETL 𝑂 \textsc{DocETL}_{O} consistently outperformed the others, demonstrating the highest recall across all metrics. In contrast, the baseline showed clear limitations, only referencing generic placeholders like “Game A, Game B, Game C” instead of actual game titles. DocETL H subscript DocETL 𝐻 \textsc{DocETL}_{H} and DocETL O subscript DocETL 𝑂 \textsc{DocETL}_{O} did not hallucinate any game titles. The themes extracted by the Baseline Pipeline also tended to be more generic, such as “Game Mechanics” and “Graphics and Visuals,” lacking the specificity observed in the other pipelines. For instance, instead of a broad “Game Mechanics” theme, DocETL O subscript DocETL 𝑂 \textsc{DocETL}_{O} identified more precise themes such as “Combat Mechanics and Difficulty,” and DocETL H subscript DocETL 𝐻 \textsc{DocETL}_{H} identified “Customization and Character Progression.”

 
 The gleaning process significantly improved output quality through specific, insightful feedback. Examples include:

 
 
 • 
 
 “Expand the extraction to include more themes prominently discussed in the original reviews, especially ones like ’Technical Issues and Game Stability’ and ’Community Support”’ 

 
 • 
 
 “Ensure that for each extracted theme, there are at least three representative games via quotes showing both positive and negative sentiments including games’ titles” 

 
 • 
 
 “Revisit each theme to provide more balance in quotes, ensuring that both sides of the argument are adequately represented across all identified themes” 

 
 • 
 
 “Consider looking at the significance of narrative depth and dialogue as a theme, reflecting on how it is viewed across games, given that many reviews mentioned how storytelling impacted player engagement” 

 
 This detailed feedback enabled targeted improvements, which the LLM clearly benefited from due to the difficulty of this reasoning task.

 
 Costs. The optimization phase, utilizing GPT-4o-mini to manage costs, required approximately one hour and incurred a cost of $35. The individual pipeline runs for DocETL O subscript DocETL 𝑂 \textsc{DocETL}_{O} and DocETL H subscript DocETL 𝐻 \textsc{DocETL}_{H} cost between $4 and $6 each (with the baseline being less expensive at $1.50-$2.50), with execution times ranging from 5 to 10 minutes. Notably, the cost variability was minimal across gleaning iterations, as the process was applied only once to the final, aggregated output rather than to many subgroups. Once again, the higher optimization cost is justified considering we evaluated hundreds of plans with varying chunk sizes for these extremely long documents. This investment in finding the best analysis is particularly valuable when such analyses are run regularly, or on a schedule.

 
 
### 
 5.3. Declassified Document Analysis

 
 To evaluate DocETL ’s choices for chunking in map operations and batching in reduce operations, we conducted an experiment using a subset of articles from The Black Vault collection, an online repository of declassified government documents containing over 3 million pages of information from around the world. We focused on articles related to paranormal case files: our dataset consisted of 733 articles, with an average length of 700 words per article. Additionally, 91 of these articles had associated PDF content or declassified files attached, averaging 200,000 words each. This combination of shorter articles and extensive supplementary documents presented an interesting challenge for our system in handling varying lengths and formats of content.

 
 We implemented a map-(resolve)-reduce pipeline to analyze the case file content, determine event types, and generate overall summaries of credible instances for each event type. The map operation extracts key information from each article, including event type (such as UFO sightings, cryptid encounters, or psychic phenomena), location, date, witnesses, and event details. The pipeline then standardized the event types to handle variations and near-duplicates using the resolve operation, and finally employed a reduce operation to aggregate the map results to generate comprehensive summaries for each event type, including timelines of credible instances and identification of location hotspots. In this experiment, we compared the following two pipeline variants:

 
 
 (1) 
 
 Baseline : This pipeline includes a map operation to identify the event type and summary of the incident, a resolve operation to deduplicate event types (synthesized by DocETL , akin to the baseline in Section   5.1 ), and a reduce operation to summarize the incident summaries for each event type. We naively truncate all documents to ≈ \approx 128k tokens to fit in LLM prompts.

 
 (2) 
 
 DocETL O subscript DocETL 𝑂 \textsc{DocETL}_{O} : This pipeline, selected by DocETL ’s optimizer, decomposes the baseline’s map operation into a split-summarize-gather-map-reduce pipeline ( Equations   1 and  3 ). The decomposition strategy first splits the data into chunks of 15,685 tokens, summarizes each chunk independently, then gathers each chunk with the previous chunk and concatenated summaries of all previous chunks (to maintain context from earlier sections of the document). It then applies a map to each rendered chunk to extract relevant details, and finally reduces all results from the same document to aggregate the individual chunk results. The reduce operation is similar to the baseline, except the optimizer determined the optimal fold batch size (i.e., number of summaries in a group to aggregate in a single LLM call, instead of aggregating all summaries).

 

 
 Results. On average, DocETL O subscript DocETL O \textsc{DocETL}_{O} ’s extracted information was 1.82 × 1.82\times more comprehensive than the baseline, as shown in Table   3 . For extracted fields such as location, date, witnesses, event details, and physical evidence, the decomposed strategy produced longer, more detailed outputs. The average length of extracted information was 1.29 to 2.78 times greater than the baseline, depending on the extracted key. Notably, for event details (the summary attribute), the decomposed strategy produced outputs that were, on average, 2.78 times longer than the baseline. Moreover, for this event attribute, DocETL O subscript DocETL 𝑂 \textsc{DocETL}_{O} ’s output was larger than the baseline approximately 95% of the time. For the witnesses attribute, DocETL O subscript DocETL 𝑂 \textsc{DocETL}_{O} found, on average 2 × 2\times as many witnesses as the baseline, indicating a significant improvement in the ability to capture and retain important information from longer documents.

 
 To further validate the comprehensiveness of DocETL O subscript DocETL 𝑂 \textsc{DocETL}_{O} ’s extractions, we conducted a pairwise comparison of the extracted fields, focusing on Event Details and Physical Evidence. We employed GPT-4o-mini as a judge to determine which output was more comprehensive for each pair of extracted fields, from DocETL O subscript DocETL 𝑂 \textsc{DocETL}_{O} and the baseline. To ensure the reliability of this automated evaluation, one of the authors manually assessed 25 examples for each field, comparing the baseline and DocETL O subscript DocETL 𝑂 \textsc{DocETL}_{O} . Remarkably, the author’s judgments aligned perfectly with the LLM’s assessments, demonstrating 100% agreement, validating the use of the LLM as a reliable judge for this task. For Event Details, DocETL O subscript DocETL 𝑂 \textsc{DocETL}_{O} ’s outputs were judged more comprehensive in 96.70% of cases, while the baseline was preferred in only 3.30% of cases , with no ties observed. The difference was also substantial for Physical Evidence, where DocETL O subscript DocETL 𝑂 \textsc{DocETL}_{O} outperformed the baseline 83.52% of the time, compared to 15.38% for the baseline , with 1.10% of cases resulting in a tie. These results corroborate our earlier findings based on output length, providing strong evidence that DocETL not only produces longer outputs but also more comprehensive and informative ones across different aspects of the extraction task.

 
 Table 3. Comparison of DocETL O subscript DocETL 𝑂 \textsc{DocETL}_{O} ’s and the baseline’s extracted information (i.e., input to the reduce operation). The length improvement factor is the ratio of DocETL O subscript DocETL 𝑂 \textsc{DocETL}_{O} ’s extracted information length to the baseline’s. 
 
 
 
 Extracted Field 
 
 
 Length Improvement Factor 
 
 
 
 
 Sample Output For a Document with ≈ 160 , 000 absent 160 000 \approx 160,000 Words ( DocETL o ​ p ​ t subscript DocETL 𝑜 𝑝 𝑡 \textsc{DocETL}_{opt} ) 
 
 
 
 
 
 
 Location 
 
 
 1.38 × 1.38\times 
 
 
 
 
 New Mexico and various locations in the United States 
 
 
 
 
 Date 
 
 
 1.29 × 1.29\times 
 
 
 
 
 1947-1988 
 
 
 
 
 Witnesses 
 
 
 2.02 × 2.02\times 
 
 
 
 
 Val Valerian, Warren Smith, Judy Doraty, Sgt. Jonathan P. Louette, Peter Jordan, … 
 
 
 
 
 Event Details 
 
 
 2.78 × 2.78\times 
 
 
 
 
 This report summarizes a series of events and phenomena related to UFO sightings, abductions, alleged governmental cover-ups, and advanced experimentation that supposedly spans several decades. Key cases include: 1. UFO abduction and interaction primarily involving the Greys, … 2. A notable UFO sighting at Kirtland AFB in 1980, … … 
 
 
 
 
 Physical Evidence 
 
 
 1.64 × 1.64\times 
 
 
 
 
 Documented physical evidence includes …unmarked helicopters, radar data of UFOs, photographs of sightings, and alleged biological samples showing abnormalities … Notable documentation also includes the Grudge and MJ-12 reports, … 
 
 
 
 
 
 
 
 Varying Fold Batch Sizes in Reduce. The most common event type found by the resolve operation was “UFO sighting,” with 548 documents mapped to this category. To evaluate the effectiveness of different fold batch sizes in the reduce operation, we focused on this “UFO sighting” event type. We varied the batch sizes from 16 to 1024 (or capped at 548, the total number of UFO sighting documents) and computed semantic similarity metrics between the resulting summaries and the individual map results. To quantify semantic similarity, we used text embeddings generated by the “text-embedding-3-small” model. We computed semantic F1 , or the harmonic mean of semantic precision (i.e., the average maximum cosine similarity between each summary sentence embedding and all input embeddings) and recall (i.e., the average maximum cosine similarity between each input embedding and all summary sentence embeddings ). Intuitively, a high precision indicates that the summary contains information that closely matches at least some part of the original data, even if it doesn’t cover everything. Conversely, high recall suggests that most of the important information from the original data is captured somewhere in the summary, even if the summary also contains additional or synthesized information. A high F1 score indicates a summary that is both accurate and comprehensive.

 
 Figure 6. Reduce Operation F1 Score vs Fold Batch Size. The x-axis shows the batch size on a log scale, while the y-axis represents the metric values. The dotted line represents the baseline (i.e., the pipeline without any chunking in the map operation or folding in the reduce operation). Metrics peak at a size significantly less than the context limit. gpt-4o-mini is the model used. 
 
 
 Figure   6 reveals interesting patterns. DocETL O subscript DocETL 𝑂 \textsc{DocETL}_{O} is 6 points higher than the baseline. For very low and very high fold batch sizes, the F1 scores are at their lowest. However, at a batch size of 128, we observe the highest semantic F1 score. These findings have important implications for optimizing LLM-based data processing pipelines. First, processing everything in a single batch, even when it fits within the LLM’s context window, may not yield the best results. Second, incremental folding (processing in smaller batches) can improve performance, but the optimal batch size is not easy to determine. As such, an optimizer like DocETL ’s is essential for dynamically selecting the best batch size based on the specific data and task at hand.

 
 Costs. For all operations in the pipeline, we utilized the gpt-4o-mini model. While DocETL O subscript DocETL 𝑂 \textsc{DocETL}_{O} demonstrated superior performance in terms of output comprehensiveness, it came at a higher computational cost. The total cost for running DocETL O subscript DocETL 𝑂 \textsc{DocETL}_{O} was $10.46, compared to $1.15 for the baseline. In the reduce operation, costs varied based on fold size, ranging from $0.46 for the smallest fold size to $0.05 for the largest. Running the agent-powered optimizer in DocETL incurred a cost of $70.71.

 
 
### 
 5.4. Tasks Posed by Prior Work

 
 While DocETL is primarily designed for complex data processing of unstructured data, we were curious to explore its performance on tasks introduced by prior work. Here, we informally compare DocETL against baselines established by LOTUS (Patel et al . , 2024 ) and Palimpzest (Liu et al . , 2024b ) . These tasks often involve structured data or relational operations, which are not DocETL ’s primary focus. We made best-effort attempts to reproduce the tasks and compare our results to those reported in their papers, acknowledging that differences in implementation may impact direct comparisons.

 
#### 
 5.4.1. Biodex Extreme Multi-label Classification

 
 Patel et al . ( 2024 ) evaluate LOTUS on a sample of 250 biomedical papers from the Biodex Dataset  (D’Oosterlinck et al . , 2023 ) . We pick the first 250 articles in the test set. The task is to label adverse drug reactions experienced by patients described in each article, using labels from the MedDRA ontology of 24,300 medical reactions. This presents a challenging multi-class classification problem. For this task, the established evaluation metric is rank-precision@k (RP@k), which measures how well the order of items in a ranked list matches the true order of relevance. Despite this task being more suited to search or relational operations, we implemented a DocETL pipeline consisting of an equijoin operation, using gpt-4o-mini and text-embedding-3-small models.

 
 Our equijoin operation uses a comparison prompt asking, “Can the following condition be found in the article?” The prompt includes both the article text and the label, as well as an indicator of whether the condition text is a substring of the article’s text. During optimization, DocETL decomposes the equijoin into a map-equijoin. The map operation extracts all medical conditions discussed in the article, and the corresponding prompt does not leverage any demonstrations or examples of labels. DocETL adds blocking rules to the equijoin, synthesizing an embedding threshold of 0.5253 and a rule to check if all words in the reaction (label) are present in the article. We manually implement a final reduce step to rank the labels for each article, as the join result is unordered and the RP metric requires ordering. Our implementation achieves an RP@5 of 0.281 and RP@10 of 0.313, compared to LOTUS’s reported best performance of RP@5 at 0.241 and RP@10 at 0.258,
an improvement of 16% and 21% respectively.

 
 Several differences exist between our implementation and that of Patel et al . ( 2024 ) . We use gpt-4o-mini, while they use Llama3-70b. Our prompting strategy does not include few-shot examples , whereas they report using 7. For ranking, we employ an LLM-powered reduce step to rank labels, which may be similar to LOTUS’s LLM-powered filter step in their best-performing pipeline. The most significant distinction lies in our equijoin implementation. Our approach relies on blocking rules to determine which pairs should be compared, while LOTUS implements equijoin by searching for the top-k similar right tuples based on embeddings for each tuple in the left relation. Notably, our code-based blocking rules check for the presence of the label in the article before forwarding the comparison to the LLM. This approach may capture pairs that don’t have high similarity scores in embedding space but should be joined, potentially explaining our improved performance.

 
 It’s worth noting that we did not explore any prompt optimizations or demonstrations , which may increase performance further; our goal was to simply see how well DocETL would do “out of the box”. Moreover, a brief examination of the data suggests that many of the human-annotated labels are not exhaustive or are occasionally incorrect (e.g., a label is given that is never referenced in the paper). This may explain the overall low performance scores, as the ground truth itself may be of varying quality.

 
 
#### 
 5.4.2. Medical Schema Matching

 
 Liu et al . ( 2024b ) evaluate Palimpzest on a sample of spreadsheets containing medical data. Their task involves downloading Excel datasets associated with cancer research papers, identifying datasets containing patient experiment data, and integrating those datasets into a single table. We used the “biofabric-tiny” dataset, which consists of three Excel files provided in Palimpzest’s GitHub repository. For one of the files, the context exceeded the LLM window.

 
 To compare with Palimpzest, we implemented a pipeline in DocETL consisting of a single map operation that uses gpt-4o-mini. Our prompt extracts patient data fields from the given table data, including case submitter ID, age at diagnosis, race, ethnicity, gender, vital status, and various tumor-related information (mimicking the Palimpzest pipeline’s convert operation). The prompt specifies that if a field is not present in the data, an empty string should be returned, with the case submitter ID being the only required field. DocETL optimized the pipeline by decomposing the map operation into several steps. First, a map operation extracts any metadata from the file, typically found in the first tab or sheet of the Excel file. Next, a split operation divides the content into chunks of 80,000 tokens. The original map operation is then applied at the chunk level, considering both the chunk and the associated file metadata. Finally, a reduce operation suggested by the optimizer queries the LLM to concatenate the submap results—though this step may be unnecessary as simple concatenation could suffice.

 
 Our implementation achieved an average F1 score of 0.59, compared to 0.5 for Palimpzest, an improvement of 18% , though their result may be outdated. It’s interesting that our system, primarily designed for unstructured documents, could produce a competitive score on this task involving structured data in tables. This suggests that our ideas, such as the map operation for metadata extraction and the chunking approach, may have broader applicability. However, our method of loading data may differ from Palimpzest’s approach, which may impact the comparison. Palimpzest’s API simply requires users to point to the directory containing Excel files, and the files can be loaded into a model in any number of ways. In our pipeline, we concatenated string representations from each sheet in the Excel file into one large document, using pandas to load the data into dataframes and convert them to strings.

 
 In future work, we plan to support code-based operations or user-defined functions instead of relying solely on LLMs, which will provide greater flexibility in operator implementation, and lead to a richer space for optimization.

 
 
 
 
## 
 6. Discussion

 
 Reflecting on our evaluation results, we observe significant variations in output quality between different candidate plans, underscoring the promise of agentic approaches in optimizing LLM-powered data processing pipelines. However, these findings also highlight the challenges inherent in optimization for such systems. The optimization process in DocETL is fundamentally a best-effort approach, relying on AI agents that, while powerful, are not infallible. The space of possible plan interpretations and decompositions is vast—potentially infinite—and we are limited by the agents’ ability to navigate this space effectively. For instance, when applying a projection synthesis rule ( Section   3.3 ), an agent could conceivably generate any number of map operations to augment or focus the context for the main operation. The quality of the resulting pipeline thus heavily depends on the agent’s ability to guide good decompositions and craft effective prompts for such decompositions.

 
 This reliance on AI agents for optimization suggests the need for a more human-in-the-loop approach. Human intuition can be invaluable in creating prompts for subtasks, or in identifying promising decomposition strategies. This is particularly important given the unintuitive nature of the Pareto frontier of plans, as observed in our results and noted in prior work  (Liu et al . , 2024b ) . The fact that some plans are both cheaper and better in terms of output quality challenges conventional optimization heuristics and makes it difficult to devise effective strategies for searching the space of possible plans.

 
 Another difficult challenge is that people often face uncertainty when defining their requirements for AI-powered pipelines. Their needs may only become clear after seeing initial outputs from the system  (Shankar et al . , 2024b , a ) . This calls for a more interactive approach to pipeline building, where users can iteratively refine their pipelines based on intermediate results. Additionally, allowing users to influence or even write the validator prompts themselves could provide a powerful mechanism to incorporate domain knowledge and specific evaluation criteria into the optimization process.

 
 It’s important to note that DocETL is not intended for tasks requiring the synthesis of new knowledge beyond what is contained in the input data or provided in operation prompts. Its strength lies in extracting, transforming, and analyzing existing information within large, unstructured datasets—–tasks that traditionally might require significant manual effort and teams of human annotators or domain experts  (Nigatu et al . , 2023 ) . This allows DocETL to excel in scenarios like our police misconduct analysis case, where it can process vast amounts of unstructured data to reveal patterns and insights.

 
 As we continue to develop DocETL , we are addressing several engineering challenges to enhance its functionality and accessibility. These include implementing robust provenance tracking to allow users to trace analyses back to source documents, developing no-code interfaces for easier pipeline construction, enabling compatibility with local LLMs for increased privacy and reduced cloud dependency, and improving scalability for larger datasets.

 
 
## 
 7. Related Work

 
 Our work on DocETL builds upon and extends several areas of research in LLM-powered data processing, declarative frameworks, and agent-based systems. Here, we discuss the most relevant prior work and highlight how DocETL advances the state of the art.

 
 LLM-powered data processing frameworks have become of significant interest to the database community in recent months. LOTUS introduces semantic operators that extend Pandas  (Patel et al . , 2024 ) , while Palimpzest offers a Python framework for declarative LLM-based processing, focusing primarily on map-like operations (e.g., “convert” and “filter”)  (Liu et al . , 2024b ) . Aryn, another Python framework with an API similar to Spark, additionally trains custom PDF extraction models and a proposes a more human-in-the-loop approach to LLM-based query processing  (Anderson et al . , 2024 ) . These systems incorporate a range of optimizations, from traditional relational techniques like predicate and projection pushdown  (Hellerstein and Stonebraker, 2005 ) to ML-specific strategies to reduce cost while maintaining accuracy, such as model cascades  (Wang et al . , 2017 ) . However, a critical limitation of these approaches is their reliance on the assumption that the most capable LLM will produce sufficiently accurate results for user-defined operations. In practice, particularly for complex tasks involving unstructured documents, even the best available models often fall far short of the required performance. These frameworks offer no mechanisms to improve upon the baseline performance of state-of-the-art LLMs, leaving a significant gap in their ability to handle challenging, real-world data processing scenarios. In contrast, DocETL recognizes that optimal LLM performance is not guaranteed and may vary significantly based on task complexity and data characteristics. To address this, DocETL employs an agent-driven approach to adaptively optimize pipelines, exploring various decomposition strategies, prompting techniques, and execution plans to achieve better results than what a single, albeit powerful, LLM call can provide. Moreover, DocETL focuses primarily on unstructured, complex document processing.

 
 Complementary to these general-purpose frameworks are specialized systems like ZenDB, which optimize workloads on templatized document collections, presenting a SQL interface  (Lin et al . , 2024 ) . While ZenDB excels in scenarios with predictable document formats, DocETL ’s YAML-based interface and focus on ETL-like tasks make it more suitable for processing diverse, unstructured data. Similarly, EVAPORATE focuses on extracting tables from semi-structured data by using LLMs to synthesize code functions  (Arora et al . , 2023 ) . Unlike DocETL , EVAPORATE does not directly apply LLMs to the data. However, synthesizing code that can accurately perform map operations, rather than using an LLM itself, is an interesting optimization technique that could work for some tasks, and we are exploring this in DocETL .

 
 The use of LLM agents for query processing represents another relevant area of research. In GraphRAG,  Edge et al . ( 2024 ) use an LLM-powered map-reduce pipeline to answer queries using a knowledge graph. Their process maps graph community summaries to query relevance, then reduces relevant context with the query into a single answer. This pipeline is certainly expressible in DocETL , which provides a more general-purpose framework. Caesura takes natural language queries and synthesizes query plans incorporating relational operators, Python UDFs, and ML models  (Urban and Binnig, 2024 ) . While Caesura proposes plan optimization as a future direction, DocETL actively employs agents in the optimization process. CleanAgent automates data standardization tasks with LLM-based agents, providing three specific operators for this purpose  (Qi and Wang, 2024 ) . However, its agents primarily execute predefined operations rather than constructing and optimizing entire pipelines. Chat2Data offers an interactive data analysis system for unstructured data in a conversational setting, focusing on retrieval tasks through embedding-based similarities  (Zhao et al . , 2024a ) . In contrast, DocETL supports more complex processing tasks and employs a declarative approach to pipeline specification.

 
 Prompt optimization has emerged as a promising technique to improving LLM performance across various tasks  (Wen et al . , 2024 ; Khattab et al . , 2024 ) . While complementary to the task decomposition strategies employed by DocETL , prompt optimization alone often falls short in document processing tasks. Even human-guided prompt engineering strategies can only go so far  (White et al . , 2023 ) , if the data and task are too complex to process in one LLM call.

 
 The concept of declarative frameworks for intelligent data processing has a rich history in database research, with crowdsourcing systems like CrowdDB, Deco, CDB, and Qurk sharing similar principles to DocETL   (Franklin et al . , 2011 ; Parameswaran et al . , 2012 ; Li et al . , 2018 ; Marcus et al . , 2011 ) . While these systems leverage human intelligence rather than LLMs, they demonstrate the power of declarative approaches in handling complex, unstructured data processing tasks. DocETL builds upon this tradition, adapting declarative principles to the unique challenges and opportunities presented by LLM-powered processing  (Parameswaran et al . , 2023 ) . By combining a flexible, low-code interface with sophisticated, agent-driven optimization techniques, DocETL represents a significant step forward in making advanced document processing capabilities accessible to a wide range of users and applications.

 
 
## 
 8. Conclusion

 
 In this paper, we introduced DocETL , a declarative system that optimizes complex document processing tasks using LLMs. By focusing on improving accuracy rather than just reducing costs, DocETL addresses critical limitations in existing LLM-powered data processing frameworks. Our system introduces several novel rewrite directives, an agent-based framework for plan rewriting and evaluation, and an opportunistic optimization strategy to handle the unique challenges of unstructured data analysis. Our evaluation across three unstructured document analysis tasks demonstrated that DocETL can find plans with outputs 1.34 to 4.6x higher quality than hand-engineered baselines. As LLMs continue to evolve and new challenges in complex document processing emerge, DocETL ’s architecture provides a flexible foundation for future research and applications.

 
 
## References

 
 
 (1) 
 

 

 
 Anderson et al . (2024) 
 
Eric Anderson, Jonathan Fritz, Austin Lee, Bohou Li, Mark Lindblad, Henry Lindeman, Alex Meyer, Parth Parmar, Tanvi Ranade, Mehul A. Shah, Benjamin Sowell, Dan Tecuci, Vinayak Thapliyal, and Matt Welsh. 2024.

 
 The Design of an LLM-powered Unstructured Analytics System.

 
 
 
 arXiv:2409.00847 [cs.DB]

 https://arxiv.org/abs/2409.00847 

 

 
 Arora et al . (2023) 
 
Simran Arora, Brandon Yang, Sabri Eyuboglu, Avanika Narayan, Andrew Hojel, Immanuel Trummer, and Christopher Ré. 2023.

 
 Language models enable simple systems for generating structured views of heterogeneous data lakes.

 
 arXiv preprint arXiv:2304.09433 (2023).

 
 
 

 
 Bai et al . (2023) 
 
Yushi Bai, Xin Lv, Jiajie Zhang, Hongchang Lyu, Jiankai Tang, Zhidian Huang, Zhengxiao Du, Xiao Liu, Aohan Zeng, Lei Hou, et al . 2023.

 
 Longbench: A bilingual, multitask benchmark for long context understanding.

 
 arXiv preprint arXiv:2308.14508 (2023).

 
 
 

 
 Chaudhuri (1998) 
 
Surajit Chaudhuri. 1998.

 
 An overview of query optimization in relational systems. In Proceedings of the seventeenth ACM SIGACT-SIGMOD-SIGART symposium on Principles of database systems . 34–43.

 
 
 

 
 Christophides et al . (2020) 
 
Vassilis Christophides, Vasilis Efthymiou, Themis Palpanas, George Papadakis, and Kostas Stefanidis. 2020.

 
 An Overview of End-to-End Entity Resolution for Big Data.

 
 ACM Comput. Surv. 53, 6, Article 127 (dec 2020), 42 pages.

 
 

 https://doi.org/10.1145/3418896 

 

 
 D’Oosterlinck et al . (2023) 
 
Karel D’Oosterlinck, François Remy, Johannes Deleu, Thomas Demeester, Chris Develder, Klim Zaporojets, Aneiss Ghodsi, Simon Ellershaw, Jack Collins, and Christopher Potts. 2023.

 
 BioDEX: Large-Scale Biomedical Adverse Drug Event Extraction for Real-World Pharmacovigilance. In Findings of the Association for Computational Linguistics: EMNLP 2023 , Houda Bouamor, Juan Pino, and Kalika Bali (Eds.). Association for Computational Linguistics, Singapore, 13425–13454.

 
 
 https://doi.org/10.18653/v1/2023.findings-emnlp.896 

 

 
 Edge et al . (2024) 
 
Darren Edge, Ha Trinh, Newman Cheng, Joshua Bradley, Alex Chao, Apurva Mody, Steven Truitt, and Jonathan Larson. 2024.

 
 From local to global: A graph rag approach to query-focused summarization.

 
 arXiv preprint arXiv:2404.16130 (2024).

 
 
 

 
 Fernandez et al . (2023) 
 
Raul Castro Fernandez, Aaron J. Elmore, Michael J. Franklin, Sanjay Krishnan, and Chenhao Tan. 2023.

 
 How Large Language Models Will Disrupt Data Management.

 
 Proc. VLDB Endow. 16, 11 (jul 2023), 3302–3309.

 
 

 https://doi.org/10.14778/3611479.3611527 

 

 
 Franklin et al . (2011) 
 
Michael J Franklin, Donald Kossmann, Tim Kraska, Sukriti Ramesh, and Reynold Xin. 2011.

 
 CrowdDB: answering queries with crowdsourcing. In Proceedings of the 2011 ACM SIGMOD International Conference on Management of data . 61–72.

 
 
 

 
 Graefe (1995) 
 
Goetz Graefe. 1995.

 
 The Cascades Framework for Query Optimization.

 
 IEEE Data(base) Engineering Bulletin 18 (1995), 19–29.

 
 
 https://api.semanticscholar.org/CorpusID:260706023 

 

 
 Hellerstein and Stonebraker (2005) 
 
Joseph M Hellerstein and Michael Stonebraker. 2005.

 
 Anatomy of a database system.

 
 Readings in Database Systems, (2005).

 
 
 

 
 Hendrycks et al . (2021) 
 
Dan Hendrycks, Collin Burns, Anya Chen, and Spencer Ball. 2021.

 
 CUAD: An Expert-Annotated NLP Dataset for Legal Contract Review.

 
 NeurIPS (2021).

 
 
 

 
 Jiang et al . (2023) 
 
Huiqiang Jiang, Qianhui Wu, Xufang Luo, Dongsheng Li, Chin-Yew Lin, Yuqing Yang, and Lili Qiu. 2023.

 
 Longllmlingua: Accelerating and enhancing llms in long context scenarios via prompt compression.

 
 arXiv preprint arXiv:2310.06839 (2023).

 
 
 

 
 Kalai and Vempala (2024) 
 
Adam Tauman Kalai and Santosh S Vempala. 2024.

 
 Calibrated language models must hallucinate. In Proceedings of the 56th Annual ACM Symposium on Theory of Computing . 160–171.

 
 
 

 
 Khattab et al . (2024) 
 
Omar Khattab, Arnav Singhvi, Paridhi Maheshwari, Zhiyuan Zhang, Keshav Santhanam, Saiful Haq, Ashutosh Sharma, Thomas T Joshi, Hanna Moazam, Heather Miller, et al . 2024.

 
 DSPy: Compiling Declarative Language Model Calls into State-of-the-Art Pipelines. In The Twelfth International Conference on Learning Representations .

 
 
 

 
 Levy et al . (2024) 
 
Mosh Levy, Alon Jacoby, and Yoav Goldberg. 2024.

 
 Same task, more tokens: the impact of input length on the reasoning performance of large language models.

 
 arXiv preprint arXiv:2402.14848 (2024).

 
 
 

 
 Li et al . (2018) 
 
Guoliang Li, Chengliang Chai, Ju Fan, Xueping Weng, Jian Li, Yudian Zheng, Yuanbing Li, Xiang Yu, Xiaohang Zhang, and Haitao Yuan. 2018.

 
 CDB: A crowd-powered database system.

 
 Proceedings of the VLDB Endowment 11, 12 (2018), 1926–1929.

 
 
 

 
 Lin et al . (2024) 
 
Yiming Lin, Madelon Hulsebos, Ruiying Ma, Shreya Shankar, Sepanta Zeigham, Aditya G Parameswaran, and Eugene Wu. 2024.

 
 Towards Accurate and Efficient Document Analytics with Large Language Models.

 
 arXiv preprint arXiv:2405.04674 (2024).

 
 
 

 
 Liu et al . (2024b) 
 
Chunwei Liu, Matthew Russo, Michael Cafarella, Lei Cao, Peter Baille Chen, Zui Chen, Michael Franklin, Tim Kraska, Samuel Madden, and Gerardo Vitagliano. 2024b.

 
 A Declarative System for Optimizing AI Workloads.

 
 arXiv preprint arXiv:2405.14696 (2024).

 
 
 

 
 Liu et al . (2024a) 
 
Nelson F Liu, Kevin Lin, John Hewitt, Ashwin Paranjape, Michele Bevilacqua, Fabio Petroni, and Percy Liang. 2024a.

 
 Lost in the middle: How language models use long contexts.

 
 Transactions of the Association for Computational Linguistics 12 (2024), 157–173.

 
 
 

 
 Liu et al . (2024c) 
 
Yinhong Liu, Han Zhou, Zhijiang Guo, Ehsan Shareghi, Ivan Vulić, Anna Korhonen, and Nigel Collier. 2024c.

 
 Aligning with Human Judgement: The Role of Pairwise Preference in Large Language Model Evaluators. In First Conference on Language Modeling .

 
 
 https://openreview.net/forum?id=9gdZI7c6yr 

 

 
 Marcus et al . (2011) 
 
Adam Marcus, Eugene Wu, David R Karger, Samuel Madden, and Robert C Miller. 2011.

 
 Crowdsourced databases: Query processing with people. Cidr.

 
 
 

 
 Nigatu et al . (2023) 
 
Hellina Hailu Nigatu, Lisa Pickoff-White, John Canny, and Sarah Chasins. 2023.

 
 Co-Designing for Transparency: Lessons from Building a Document Organization Tool in the Criminal Justice Domain. In Proceedings of the 2023 ACM conference on fairness, accountability, and transparency . 1463–1478.

 
 
 

 
 Nye et al . (2021) 
 
Maxwell Nye, Anders Johan Andreassen, Guy Gur-Ari, Henryk Michalewski, Jacob Austin, David Bieber, David Dohan, Aitor Lewkowycz, Maarten Bosma, David Luan, et al . 2021.

 
 Show your work: Scratchpads for intermediate computation with language models.

 
 arXiv preprint arXiv:2112.00114 (2021).

 
 
 

 
 Pallets (2024) 
 
Pallets. 2024.

 
 Jinja.

 
 https://github.com/pallets/jinja/ .

 
 
 
 Version 3.1.x.

 

 
 Parameswaran et al . (2012) 
 
Aditya Ganesh Parameswaran, Hyunjung Park, Hector Garcia-Molina, Neoklis Polyzotis, and Jennifer Widom. 2012.

 
 Deco: declarative crowdsourcing. In Proceedings of the 21st ACM international conference on Information and knowledge management . 1203–1212.

 
 
 

 
 Parameswaran et al . (2023) 
 
Aditya G Parameswaran, Shreya Shankar, Parth Asawa, Naman Jain, and Yujie Wang. 2023.

 
 Revisiting prompt engineering via declarative crowdsourcing.

 
 arXiv preprint arXiv:2308.03854 (2023).

 
 
 

 
 Patel et al . (2024) 
 
Liana Patel, Siddharth Jha, Carlos Guestrin, and Matei Zaharia. 2024.

 
 LOTUS: Enabling Semantic Queries with LLMs Over Tables of Unstructured and Structured Data.

 
 arXiv preprint arXiv:2407.11418 (2024).

 
 
 

 
 Peng et al . (2024) 
 
Binghui Peng, Srini Narayanan, and Christos Papadimitriou. 2024.

 
 On limitations of the transformer architecture.

 
 arXiv preprint arXiv:2402.08164 (2024).

 
 
 

 
 Qi and Wang (2024) 
 
Danrui Qi and Jiannan Wang. 2024.

 
 CleanAgent: Automating Data Standardization with LLM-based Agents.

 
 arXiv preprint arXiv:2403.08291 (2024).

 
 
 

 
 Shankar et al . (2024a) 
 
Shreya Shankar, Haotian Li, Parth Asawa, Madelon Hulsebos, Yiming Lin, JD Zamfirescu-Pereira, Harrison Chase, Will Fu-Hinthorn, Aditya G Parameswaran, and Eugene Wu. 2024a.

 
 Spade: Synthesizing assertions for large language model pipelines.

 
 arXiv preprint arXiv:2401.03038 (2024).

 
 
 

 
 Shankar et al . (2024b) 
 
Shreya Shankar, JD Zamfirescu-Pereira, Björn Hartmann, Aditya G Parameswaran, and Ian Arawjo. 2024b.

 
 Who Validates the Validators? Aligning LLM-Assisted Evaluation of LLM Outputs with Human Preferences.

 
 arXiv preprint arXiv:2404.12272 (2024).

 
 
 

 
 Shi et al . (2023) 
 
Freda Shi, Xinyun Chen, Kanishka Misra, Nathan Scales, David Dohan, Ed H Chi, Nathanael Schärli, and Denny Zhou. 2023.

 
 Large language models can be easily distracted by irrelevant context. In International Conference on Machine Learning . PMLR, 31210–31227.

 
 
 

 
 Sobkowicz and Stokowiec (2016) 
 
Antoni Sobkowicz and Wojciech Stokowiec. 2016.

 
 Steam review dataset-new, large scale sentiment dataset. In Proceedings of the Tenth International Conference on Language Resources and Evaluation (LREC 2016) Workshop Emotion and Sentiment Analysis . 55–58.

 
 
 

 
 Sui et al . (2024) 
 
Peiqi Sui, Eamon Duede, Sophie Wu, and Richard Jean So. 2024.

 
 Confabulation: The Surprising Value of Large Language Model Hallucinations.

 
 arXiv preprint arXiv:2406.04175 (2024).

 
 
 

 
 Tang et al . (2023) 
 
Raphael Tang, Xinyu Zhang, Xueguang Ma, Jimmy Lin, and Ferhan Ture. 2023.

 
 Found in the middle: Permutation self-consistency improves listwise ranking in large language models.

 
 arXiv preprint arXiv:2310.07712 (2023).

 
 
 

 
 Urban and Binnig (2024) 
 
Matthias Urban and Carsten Binnig. 2024.

 
 Demonstrating CAESURA: Language Models as Multi-Modal Query Planners. In Companion of the 2024 International Conference on Management of Data . 472–475.

 
 
 

 
 van Schaik and Pugh (2024) 
 
Tempest A. van Schaik and Brittany Pugh. 2024.

 
 A Field Guide to Automatic Evaluation of LLM-Generated Summaries. In Annual International ACM SIGIR Conference on Research and Development in Information Retrieval .

 
 
 https://api.semanticscholar.org/CorpusID:271114432 

 

 
 Wang et al . (2017) 
 
Xin Wang, Yujia Luo, Daniel Crankshaw, Alexey Tumanov, Fisher Yu, and Joseph E Gonzalez. 2017.

 
 Idk cascades: Fast deep learning by learning not to overthink.

 
 arXiv preprint arXiv:1706.00885 (2017).

 
 
 

 
 Wen et al . (2024) 
 
Yuxin Wen, Neel Jain, John Kirchenbauer, Micah Goldblum, Jonas Geiping, and Tom Goldstein. 2024.

 
 Hard prompts made easy: Gradient-based discrete optimization for prompt tuning and discovery.

 
 Advances in Neural Information Processing Systems 36 (2024).

 
 
 

 
 White et al . (2023) 
 
Jules White, Quchen Fu, Sam Hays, Michael Sandborn, Carlos Olea, Henry Gilbert, Ashraf Elnashar, Jesse Spencer-Smith, and Douglas C Schmidt. 2023.

 
 A prompt pattern catalog to enhance prompt engineering with chatgpt.

 
 arXiv preprint arXiv:2302.11382 (2023).

 
 
 

 
 Zhao et al . (2024b) 
 
Jun Zhao, Can Zu, Hao Xu, Yi Lu, Wei He, Yiwen Ding, Tao Gui, Qi Zhang, and Xuanjing Huang. 2024b.

 
 LongAgent: Scaling Language Models to 128k Context through Multi-Agent Collaboration.

 
 arXiv preprint arXiv:2402.11550 (2024).

 
 
 

 
 Zhao et al . (2024a) 
 
Xinyang Zhao, Xuanhe Zhou, and Guoliang Li. 2024a.

 
 Chat2Data: An Interactive Data Analysis System with RAG, Vector Databases and LLMs.

 
 Proc. VLDB Endow (2024).

 
 
 

 
 
 

 
## 
 Appendix A Gather Operator Specifications

 
### 
 A.1. Gather Configuration

 
 The gather operation’s configuration includes:

 
 
 
 • 
 
 The group ID key (document ID)

 
 • 
 
 The order key (chunk sequence within a group)

 
 • 
 
 The content key (field containing chunk content)

 
 • 
 
 The peripheral chunk configuration

 

 
 The peripheral chunk configuration specifies “previous” and “next” sections, each potentially containing “head”, “middle”, and “tail” subsections, determining which surrounding chunks to include and how many. Each subsection must specify a content_key denoting the field to use as the content of the chunk.

 
 
### 
 A.2. Header Lineage Preservation

 
 Figure 7. Example of Document Header Handling in a Gather Operation for Legal Contracts  (Hendrycks et al . , 2021 ) . The example document has 74 pages. Headers are extracted from chunks via map operations. When rendering a chunk (e.g., Chunk 20), the operation includes the most recent headers of all levels (1, 2, etc.) above the first header in the current chunk, so the LLM has hierarchical context when processing the chunk. 
 
 
 A unique feature of the gather operation is its ability to maintain document structure through headers. This is particularly useful for documents with complex structures where processing a chunk with a certain level header requires knowledge of headers in the levels above, which may be in other chunks.

 
 When a doc_header_key is specified in the configuration, the gather operation:

 
 
 
 (1) 
 
 Examines the doc_header_key field for every chunk preceding the one being rendered.

 
 (2) 
 
 Reconstructs the relevant header structure by identifying the level of the first header in the current chunk and including all most recent headers from higher levels found in previous chunks.

 
 (3) 
 
 Arranges these headers in their proper order.

 

 
 This process ensures that each rendered chunk includes a complete “path” of headers leading to its content, preserving the document’s overall structure and context even when split across multiple chunks.

 
 Figure   7 demonstrates header handling in a gather operation for a 74-page legal contract. Headers are extracted from chunks via map operations. When rendering a chunk (e.g., Chunk 20), the operation includes the most recent headers of all levels (1, 2, etc.) above the first header in the current chunk, providing hierarchical context for LLM processing.
