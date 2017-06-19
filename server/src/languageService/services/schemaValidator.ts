import { ASTVisitor} from '../utils/astServices';
import { YAMLNode, Kind, YAMLScalar, YAMLSequence, YAMLMapping, YamlMap, YAMLAnchorReference } from 'yaml-ast-parser';
import { JSONSchema } from "../jsonSchema";
import { SchemaToMappingTransformer } from "../schemaToMappingTransformer"
import { DiagnosticSeverity } from "vscode-languageserver-types/lib/main";
import { error } from "util";
import { xhr,configure as getErrorStatusDescription } from 'request-light';
import { ErrorHandler } from '../utils/errorHandler';
import {load as yamlLoader, YAMLDocument, YAMLException} from 'yaml-ast-parser-beta';

export class YAMLSChemaValidator extends ASTVisitor {
  private schema: JSONSchema;
  private lineCount;
  private kuberSchema: JSONSchema;
  private errorHandler: ErrorHandler;
  private textDoc;

  constructor(schema: JSONSchema, document) {
    super();
    this.schema = schema;
    this.kuberSchema = new SchemaToMappingTransformer(this.schema).getSchema();
    this.errorHandler = new ErrorHandler(document);
    this.textDoc = document;
  }

  /**
   * Perform a search navigating down the model looking if there exists a pathway to the node
   * @param {YAMLNode} node - The node we need to traverse to
   */
  public traverseBackToLocation(node:YAMLNode): void {

      let rootNode = node;
      let nodesToSearch = [];

      if(!rootNode.mappings){
        rootNode.mappings = [];
      }

      rootNode.mappings.forEach(element => {
        if(this.kuberSchema["rootNodes"][element.key.value]){
          nodesToSearch.push([element]);
        }else if(this.kuberSchema["childrenNodes"][element.key.value]){
          this.errorHandler.addErrorResult(element, "Command is not a root node", DiagnosticSeverity.Warning);
        }else{
          this.errorHandler.addErrorResult(element, "Command not found in k8s", DiagnosticSeverity.Warning);
        }
      });

      while(nodesToSearch.length > 0){
        let currentNodePath = nodesToSearch.pop();
        let currentNode = currentNodePath[currentNodePath.length - 1];

        //Do some error checking on the current key
        //If there is an error then throw the error on it and don't add the children
        
        //Error: If key not found
        if(!this.kuberSchema["childrenNodes"][currentNode.key.value]){
          this.errorHandler.addErrorResult(currentNode.key, "Command not found in k8s", DiagnosticSeverity.Warning);
        }

        //Error: It did not validate correctly
        if(!this.isValid(currentNodePath)){
          this.errorHandler.addErrorResult(currentNode.key, "This is not a valid statement", DiagnosticSeverity.Warning);
        }

        //Error: If type is mapping then we need to check the scalar type
        if(currentNode.kind === Kind.MAPPING && currentNode.value !== null && this.isInvalidType(currentNode)){
          this.errorHandler.addErrorResult(currentNode.value, "Not a valid type", DiagnosticSeverity.Warning);
        }

        let childrenNodes = this.generateChildren(currentNode.value);
        childrenNodes.forEach(child => {
          //We are getting back a bunch of nodes which all have a key and we adding them

          let newNodePath = currentNodePath.concat(child);
          if(!this.isValid(newNodePath)){

            if(!this.kuberSchema["childrenNodes"][child.key.value]){
              this.errorHandler.addErrorResult(child, "Command not found in k8s", DiagnosticSeverity.Warning);
            }

            this.errorHandler.addErrorResult(child, "This is not a valid child node of the parent", DiagnosticSeverity.Warning);
          }else{         
            nodesToSearch.push(newNodePath);
          }
        
        });

      }

  }

  private isInvalidType(node){
     
     if(!node) return false;

     let nodeTypes = this.kuberSchema["childrenNodes"][node.key.value].map(x => x.type);
     let nodeTypesUnique = Array.from(new Set(nodeTypes));

     let nodeToTest = node.value.valueObject !== undefined ? node.value.valueObject : node.value.value;
     if(node.value.mappings || node.value.items || nodeToTest === undefined){
       return false;
     }

     //Typescript doesn't have integer it has value so we need to check if its an integer
     if(typeof nodeToTest === 'number'){
       return nodeTypesUnique.indexOf("integer") === -1;  
     }

     //Not working
     if(typeof nodeToTest === 'object'){
       let dateToTest = new Date(nodeToTest);
       return dateToTest.toString() === 'Invalid Date' ? true: false;
     }

     return nodeTypesUnique.indexOf(typeof nodeToTest) === -1;

  }

  private isValid(node){
    let parentNodes = this.getParentNodes(node);
    
    if(parentNodes.length === 0){
      return true; 
    }
    
    let parent = parentNodes[parentNodes.length - 2];
    let child = parentNodes[parentNodes.length - 1];
    if(this.kuberSchema["childrenNodes"][parent]){
      let parentChildNodes = this.kuberSchema["childrenNodes"][parent].map(x => x.children);
      let parentChildNodesFlatten = [].concat.apply([], parentChildNodes);
      let parentChildNodesUnique = Array.from(new Set(parentChildNodesFlatten));
      return parentChildNodesUnique.indexOf(child) !== -1;
    }

    return false;

  }

  private getParentNodes(nodeList){
    if(nodeList.length ===  1) return []; //Case when its a root node

    let parentNodeNameList = [];
    for(let nodeCount = 0; nodeCount <= nodeList.length - 1; nodeCount++){
      parentNodeNameList.push(nodeList[nodeCount].key.value);
    }
    return parentNodeNameList;
  }

  private generateChildren(node){
    if(!node) return [];
    switch(node.kind){
      case Kind.SCALAR :
        return [];
      case Kind.MAPPING : 
        return node;
      case Kind.MAP :
        return (<YamlMap> node).mappings;
      case Kind.SEQ :
        return (<YAMLSequence> node).items;
    }
  }

  public getErrorResults(){   
    return this.errorHandler.getErrorResultsList();
  }

}
